import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyseSmallFiles } from "./analyse-small.ts";
import { emptyFileAnalysis } from "#src/types/file-analysis.ts";
import { metaId } from "#src/pipeline/paths.ts";
import type { MetaPaths } from "#src/types/meta-paths.ts";
import type { FileAnalyzer, SourceReader } from "#src/types/pipeline.ts";
import type { ConcurrencyLimiter } from "#src/pipeline/concurrency.ts";
import type { ScanManifest, ScanManifestEntry } from "#src/scan-manifest.ts";

// Pass-through limiter — analyse-small only needs the call to run.
const limiter = ((task: () => Promise<unknown>) => task()) as unknown as ConcurrencyLimiter;

const TOKENS = { inputTokens: 120, outputTokens: 45, costUsd: 0.0031 };

async function makeMetaPaths(): Promise<{ metaPaths: MetaPaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "analyse-small-"));
  const fileAnalysisDir = path.join(root, "file-analysis");
  await mkdir(fileAnalysisDir, { recursive: true });
  const metaPaths = {
    repositoryDir: root,
    metaOutputRoot: root,
    metaRoot: root,
    fileAnalysisDir,
    folderSummariesDir: path.join(root, "folder-summaries"),
    bigFileAnalysisDir: path.join(root, "big-file-analysis"),
    bigFileChunksDir: path.join(root, "big-file-chunks"),
    bigFilesJson: path.join(root, "bigFiles.json"),
    scanManifestJson: path.join(root, "scan-manifest.json"),
    repoSummaryJson: path.join(root, "repo-summary.json"),
  } satisfies MetaPaths;
  return { metaPaths, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function smallEntry(relativePath: string): ScanManifestEntry {
  return { relativePath, absolutePath: `/abs/${relativePath}`, sizeBytes: 100, tokenCount: 25, kind: "small" };
}

function manifestOf(...entries: ScanManifestEntry[]): ScanManifest {
  return {
    generatedAt: "1970-01-01T00:00:00.000Z",
    summary: {
      totalFiles: entries.length,
      smallCount: entries.filter((e) => e.kind === "small").length,
      bigCount: 0,
      oversizedCount: 0,
      totalTokens: 0,
      estimatedBigChunks: 0,
    },
    entries,
  };
}

const source = { readFile: async () => "console.log('hi')" } as unknown as SourceReader;

function countingAnalyzer(): { analyzer: FileAnalyzer; calls: () => number } {
  let calls = 0;
  const analyzer: FileAnalyzer = {
    analyze: async () => {
      calls += 1;
      return { language: "typescript", analysis: emptyFileAnalysis(), tokenUsage: { ...TOKENS } };
    },
  };
  return { analyzer, calls: () => calls };
}

// Analyzer whose single call was served from the @bb/llm disk cache: it reports
// the original token usage AND flags the whole result as cached.
function cacheHitAnalyzer(): { analyzer: FileAnalyzer; calls: () => number } {
  let calls = 0;
  const analyzer: FileAnalyzer = {
    analyze: async () => {
      calls += 1;
      return {
        language: "typescript",
        analysis: emptyFileAnalysis(),
        tokenUsage: { ...TOKENS },
        cachedTokenUsage: { ...TOKENS },
      };
    },
  };
  return { analyzer, calls: () => calls };
}

test("resume counts the prior attempt's tokens (start→complete parity)", async () => {
  const { metaPaths, cleanup } = await makeMetaPaths();
  try {
    const { analyzer, calls } = countingAnalyzer();
    const manifest = manifestOf(smallEntry("src/a.ts"));

    // Run 1: fresh provider call — counted as total, nothing cached.
    const first = await analyseSmallFiles({ knowledgeId: "k", manifest, source, metaPaths, analyzer, limiter });
    expect(calls()).toBe(1);
    expect(first.tokenUsage.inputTokens).toBe(TOKENS.inputTokens);
    expect(first.tokenUsage.costUsd).toBeCloseTo(TOKENS.costUsd);
    expect(first.cachedTokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });

    // Run 2: resume — condensed JSON on disk, no LLM call. Tokens must still be
    // counted, and the WHOLE file counts as cached (no fresh spend this run).
    const second = await analyseSmallFiles({ knowledgeId: "k", manifest, source, metaPaths, analyzer, limiter });
    expect(calls()).toBe(1); // no re-burn
    expect(second.tokenUsage).toEqual(first.tokenUsage);
    expect(second.cachedTokenUsage).toEqual(first.tokenUsage); // fully cached
    expect(second.smallFilesAnalysed).toBe(1);
  } finally {
    await cleanup();
  }
});

test("resume tolerates a condensed file with no tokenUsage (oversized-stub guard)", async () => {
  const { metaPaths, cleanup } = await makeMetaPaths();
  try {
    const { analyzer, calls } = countingAnalyzer();
    // Pre-seed a condensed JSON WITHOUT a tokenUsage field (e.g. an oversized stub).
    const rel = "src/huge.ts";
    const condensedPath = path.join(metaPaths.fileAnalysisDir, `${metaId(rel)}.json`);
    await writeFile(condensedPath, JSON.stringify({ relativePath: rel, analysis: emptyFileAnalysis() }), "utf8");

    const result = await analyseSmallFiles({
      knowledgeId: "k",
      manifest: manifestOf(smallEntry(rel)),
      source,
      metaPaths,
      analyzer,
      limiter,
    });

    expect(calls()).toBe(0); // resumed, no LLM call
    expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.cachedTokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.smallFilesAnalysed).toBe(1);
  } finally {
    await cleanup();
  }
});

test("a fresh file served from the @bb/llm cache is counted as cached, not billed", async () => {
  const { metaPaths, cleanup } = await makeMetaPaths();
  try {
    const { analyzer, calls } = cacheHitAnalyzer();
    const result = await analyseSmallFiles({
      knowledgeId: "k",
      manifest: manifestOf(smallEntry("src/cached.ts")),
      source,
      metaPaths,
      analyzer,
      limiter,
    });

    expect(calls()).toBe(1); // the analyzer ran, but its call hit the disk cache
    expect(result.tokenUsage).toEqual({ ...TOKENS }); // total reflects the work
    expect(result.cachedTokenUsage).toEqual({ ...TOKENS }); // …and it's all cached
    // fresh (billable) = total − cached = 0
    expect(result.tokenUsage.inputTokens - result.cachedTokenUsage.inputTokens).toBe(0);
  } finally {
    await cleanup();
  }
});
