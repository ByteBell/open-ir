import { createHash } from "node:crypto";
import { logger } from "@bb/logger";
import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import type { AskLlmOptions } from "@bb/llm";
import { LlmConfigError, LlmError } from "@bb/errors";
import { metaId } from "#src/pipeline/paths.ts";
import type { MetaPaths } from "#src/types/meta-paths.ts";
import type { AnalyzedFileResult, SourceReader } from "#src/types/pipeline.ts";
import type { ProgressContext } from "#src/progress/types.ts";
import type { ConcurrencyLimiter } from "#src/pipeline/concurrency.ts";
import type { ChunkAnalysisResult, FileChunk, HugeFileManifest } from "#src/types/big-file.ts";
import type { CondensedFileAnalysis } from "#src/types/condensed-file-analysis.ts";
import { throwIfCancelled, CancellationError } from "#src/pipeline/cancellation.ts";
import { MAX_LLM_ATTEMPTS, retryLlmCall } from "#src/pipeline/retry-llm.ts";
import { inspect } from "#src/big-file/cache.ts";
import { splitFileIntoChunks } from "#src/big-file/chunker.ts";
import { analyzeChunk } from "#src/big-file/chunk-analyzer.ts";
import { condenseChunks } from "#src/big-file/condenser.ts";
import { loadChunkIfPresent, readCondensed, saveChunk, saveCondensed, saveManifest } from "#src/big-file/storage.ts";
import type { ScanManifest, ScanManifestEntry } from "#src/scan-manifest.ts";
import type { ProcessBigFilesResult } from "#src/phases/process-big-files.ts";
import { describe } from "#src/phases/process-big-files.ts";
import { addUsage, createTokenAccumulator } from "#src/types/token-usage.ts";

export interface AnalyseBigFilesInput {
  knowledgeId: string;
  manifest: ScanManifest;
  source: SourceReader;
  metaPaths: MetaPaths;
  limiter: ConcurrencyLimiter;
  llmCallContext?: AskLlmOptions;
  progressContext?: ProgressContext;
}

interface BigFileState {
  entry: ScanManifestEntry;
  content: string;
  chunks: FileChunk[];
  results: (ChunkAnalysisResult | undefined)[];
  pendingChunks: number;
  fatal: boolean;
}

/**
 * Manifest-driven big-file phase. Every chunk of every big file is an
 * independent task scheduled through the shared LLM limiter. As soon as the
 * last chunk of a given file lands, that file's condense is scheduled —
 * multiple condenses run in parallel with the still-pending chunks of slower
 * files. All LLM calls (chunk + condense) check out from the same limiter.
 *
 * Files already fully processed (manifest + condensed on disk) are skipped.
 */
export async function analyseBigFiles(input: AnalyseBigFilesInput): Promise<ProcessBigFilesResult> {
  const maxTokensPerChunk = getConfigValue(Config.MaxTokensPerChunk);
  const bigEntries = input.manifest.entries.filter((e) => e.kind === "big");

  let cached = 0;
  let failed = 0;
  let processed = 0;
  // Tracks total + cached usage; resumed/disk-loaded work counts as fully cached.
  const usage = createTokenAccumulator();

  // Per-file preparation: read content, chunk, record state. Sequential and
  // cheap — no LLM calls here.
  const states: BigFileState[] = [];
  for (const entry of bigEntries) {
    throwIfCancelled(input.knowledgeId);
    const status = await inspect(input.metaPaths, entry.relativePath);
    if (status === "complete") {
      // Already condensed on a prior attempt — count its persisted token cost so
      // the per-run total reflects start→complete. Resumed from disk → fully cached.
      const resumed = await readCondensed(input.metaPaths, entry.relativePath);
      usage.add(resumed?.tokenUsage, resumed?.tokenUsage);
      cached += 1;
      continue;
    }
    let content: string;
    try {
      content = await input.source.readFile(entry.relativePath);
    } catch (cause: unknown) {
      failed += 1;
      logger.warn(`analyse-big: read failed for ${entry.relativePath}: ${describe(cause)}`);
      continue;
    }
    if (content.length === 0) {
      failed += 1;
      logger.warn(`analyse-big: empty content for ${entry.relativePath}; skipping`);
      continue;
    }
    const chunks = splitFileIntoChunks(entry.relativePath, content, maxTokensPerChunk);
    states.push({
      entry,
      content,
      chunks,
      results: new Array(chunks.length),
      pendingChunks: chunks.length,
      fatal: false,
    });
    logger.info(`analyse-big: ${entry.relativePath} split into ${chunks.length} chunks`);
  }

  const totalChunks = states.reduce((acc, s) => acc + s.chunks.length, 0);
  const chunkReporter = input.progressContext?.reporter({
    phase: "file_analysis",
    subPhase: "big_files_chunks",
    total: { kind: "fixed", total: totalChunks },
  });
  await chunkReporter?.start();
  const condenseReporter = input.progressContext?.reporter({
    phase: "file_analysis",
    subPhase: "big_files_condense",
    total: { kind: "fixed", total: states.length },
  });
  await condenseReporter?.start();

  // For oversized entries the legacy phase counted them; we accept the manifest
  // already accounted for them via the small phase (which writes the stub).
  // Surfaced here for parity with the legacy result shape.
  const skippedOversized = input.manifest.entries.filter((e) => e.kind === "oversized").length;

  const condensePromises: Promise<void>[] = [];

  function maybeScheduleCondense(state: BigFileState): void {
    if (state.pendingChunks > 0 || state.fatal) {
      return;
    }
    const definedResults = state.results.filter((r): r is ChunkAnalysisResult => r !== undefined);
    condensePromises.push(
      input.limiter(async () => {
        throwIfCancelled(input.knowledgeId);
        let merged: AnalyzedFileResult | null = null;
        try {
          merged = await retryLlmCall(
            () => condenseChunks(state.entry.relativePath, definedResults, input.llmCallContext),
            { phase: "analyse-big-condense", unit: state.entry.relativePath },
          );
        } catch (cause: unknown) {
          if (cause instanceof CancellationError || cause instanceof LlmConfigError) {
            throw cause;
          }
          failed += 1;
          logger.warn(
            `analyse-big: condense failed after ${MAX_LLM_ATTEMPTS} attempts for ${state.entry.relativePath}: ${describe(cause)}`,
          );
        }
        if (merged === null) {
          condenseReporter?.increment(1, { fileName: state.entry.relativePath });
          return;
        }

        try {
          const chunkInputTokens = definedResults.reduce((acc, r) => acc + (r.tokenUsage?.inputTokens ?? 0), 0);
          const chunkOutputTokens = definedResults.reduce((acc, r) => acc + (r.tokenUsage?.outputTokens ?? 0), 0);
          const chunkCostUsd = definedResults.reduce((acc, r) => acc + (r.tokenUsage?.costUsd ?? 0), 0);
          const totalTokenCount = state.chunks.reduce((acc, c) => acc + c.tokenCount, 0);
          const totalIn = chunkInputTokens + (merged.tokenUsage?.inputTokens ?? 0);
          const totalOut = chunkOutputTokens + (merged.tokenUsage?.outputTokens ?? 0);
          const totalCost = chunkCostUsd + (merged.tokenUsage?.costUsd ?? 0);
          // Cached subset = cached chunks (incl. disk-loaded) + cached condense step.
          const cachedSub = addUsage(merged.cachedTokenUsage, ...definedResults.map((r) => r.cachedTokenUsage));

          const manifest: HugeFileManifest = {
            relativePath: state.entry.relativePath,
            totalChunks: state.chunks.length,
            totalTokenCount,
            chunkPaths: state.chunks.map((_, i) => `chunks/${metaId(state.entry.relativePath)}/chunk-${i}.json`),
            generatedAt: new Date().toISOString(),
          };
          await saveManifest(input.metaPaths, manifest);

          const condensed: CondensedFileAnalysis = {
            relativePath: state.entry.relativePath,
            language: merged.language,
            sha256: sha256(state.content),
            sizeBytes: state.entry.sizeBytes,
            tokenCount: totalTokenCount,
            isBigFile: true,
            totalChunks: state.chunks.length,
            totalTokenCount,
            analysedAt: new Date().toISOString(),
            analysis: merged.analysis,
            tokenUsage: { inputTokens: totalIn, outputTokens: totalOut, costUsd: totalCost },
            cachedTokenUsage: cachedSub,
          };
          await saveCondensed(input.metaPaths, condensed);

          usage.add({ inputTokens: totalIn, outputTokens: totalOut, costUsd: totalCost }, cachedSub);
          processed += 1;
        } catch (cause: unknown) {
          if (cause instanceof CancellationError) {
            throw cause;
          }
          failed += 1;
          logger.warn(`analyse-big: persist failed for ${state.entry.relativePath}: ${describe(cause)}`);
        } finally {
          condenseReporter?.increment(1, { fileName: state.entry.relativePath });
        }
      }),
    );
  }

  const chunkPromises: Promise<void>[] = [];
  for (const state of states) {
    for (let i = 0; i < state.chunks.length; i += 1) {
      const idx = i;
      const chunk = state.chunks[idx];
      if (chunk === undefined) {
        continue;
      }
      chunkPromises.push(
        input.limiter(async () => {
          throwIfCancelled(input.knowledgeId);
          try {
            const cachedChunk = await loadChunkIfPresent(input.metaPaths, state.entry.relativePath, idx);
            if (cachedChunk !== null) {
              // Loaded from disk → no fresh call this run; whole chunk is cached.
              cachedChunk.cachedTokenUsage = cachedChunk.tokenUsage;
              state.results[idx] = cachedChunk;
            } else {
              const analyzed = await retryLlmCall(() => analyzeChunk(chunk, input.llmCallContext), {
                phase: "analyse-big-chunk",
                unit: `${state.entry.relativePath}#chunk-${String(idx)}`,
              });
              await saveChunk(input.metaPaths, analyzed);
              state.results[idx] = analyzed;
            }
          } catch (cause: unknown) {
            if (cause instanceof CancellationError) {
              throw cause;
            }
            if (cause instanceof LlmConfigError) {
              state.fatal = true;
              throw cause;
            }
            // Transient LLM/network failure after MAX_LLM_ATTEMPTS — flag the
            // file as fatal so the still-pending chunks don't trigger a
            // condense that would be missing inputs. Disk cache + scan
            // manifest let the next queue attempt resume only the missing
            // chunks for this file.
            state.fatal = true;
            failed += 1;
            logger.warn(
              `analyse-big: chunk ${idx + 1}/${state.chunks.length} failed after ${MAX_LLM_ATTEMPTS} attempts for ${state.entry.relativePath}: ${describe(cause)}`,
            );
          } finally {
            state.pendingChunks -= 1;
            chunkReporter?.increment(1, { fileName: `${state.entry.relativePath}#chunk-${String(idx)}` });
            maybeScheduleCondense(state);
          }
        }),
      );
    }
  }

  try {
    await Promise.all(chunkPromises);
    await Promise.all(condensePromises);
  } finally {
    chunkReporter?.stop();
    condenseReporter?.stop();
  }

  logger.info(
    `analyse-big done: processed=${processed} cached=${cached} failed=${failed} skippedOversized=${skippedOversized}`,
  );
  if (failed > 0) {
    throw new LlmError(
      `analyse-big: ${failed} file(s) failed after ${MAX_LLM_ATTEMPTS} attempts each — retry will resume from disk`,
    );
  }
  return {
    processed,
    cached,
    failed,
    skippedOversized,
    tokenUsage: usage.total(),
    cachedTokenUsage: usage.cached(),
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
