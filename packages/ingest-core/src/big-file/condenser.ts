import { askJsonLLM, tokenLen, type AskLlmOptions } from "@bb/llm";
import { LlmConfigError, LlmError } from "@bb/errors";
import { logger } from "@bb/logger";
import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import type { FileAnalysis, FileAnalysisSection } from "@bb/db-core";
import type { ChunkAnalysisResult } from "@bb/ingest-core";
import type { AnalyzedFileResult } from "@bb/ingest-core";
import { FALLBACK_LANGUAGE, emptyFileAnalysis } from "@bb/ingest-core";
import { shapeAnalysis } from "@bb/ingest-core";
import { CONDENSE_SYSTEM_PROMPT, buildCondenseUserPrompt } from "#src/prompts/condense.ts";
import { ZERO_USAGE, addUsage } from "@bb/ingest-core";

export async function condenseChunks(
  relativePath: string,
  chunks: ChunkAnalysisResult[],
  llmCallContext?: AskLlmOptions,
): Promise<AnalyzedFileResult> {
  const dedupThreshold = getConfigValue(Config.SmallFileDedupThreshold);
  if (chunks.length === 0) {
    return { language: FALLBACK_LANGUAGE, analysis: emptyFileAnalysis() };
  }
  if (chunks.length <= dedupThreshold) {
    logger.info(`condenseChunks: ${relativePath} dedup-merging ${chunks.length} chunks`);
    return deterministicMerge(chunks);
  }
  logger.info(`condenseChunks: ${relativePath} recursive condense over ${chunks.length} chunks`);
  return await condenseRecursively(relativePath, chunks, 0, llmCallContext);
}

async function condenseRecursively(
  relativePath: string,
  items: ChunkAnalysisResult[],
  depth: number,
  llmCallContext?: AskLlmOptions,
): Promise<AnalyzedFileResult> {
  if (items.length === 1) {
    const only = items[0];
    if (only === undefined) {
      return { language: FALLBACK_LANGUAGE, analysis: emptyFileAnalysis() };
    }
    return {
      language: only.language,
      analysis: only.analysis,
      tokenUsage: only.tokenUsage,
      cachedTokenUsage: only.cachedTokenUsage,
    };
  }
  const contextLimit = getConfigValue(Config.CondenseContextLimit);
  const promptOverhead = getConfigValue(Config.CondensePromptOverhead);
  const serialized = serializeItems(items);
  const promptTokens = tokenLen(serialized) + promptOverhead;
  if (promptTokens <= contextLimit) {
    return await condenseOne(relativePath, items, llmCallContext);
  }
  const budget = Math.max(contextLimit - promptOverhead, 2000);
  const batches = batchByTokenBudget(items, budget);
  logger.info(
    `condenseChunks: ${relativePath} depth=${depth} items=${items.length} promptTokens=${promptTokens} -> ${batches.length} batches`,
  );
  const partials: AnalyzedFileResult[] = [];
  for (const batch of batches) {
    partials.push(await condenseOne(relativePath, batch, llmCallContext));
  }
  const result = await condenseRecursively(relativePath, partials.map(toChunkResult), depth + 1, llmCallContext);
  const sumTokens = partials.reduce(
    (acc, p) => ({
      inputTokens: acc.inputTokens + (p.tokenUsage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (p.tokenUsage?.outputTokens ?? 0),
      costUsd: acc.costUsd + (p.tokenUsage?.costUsd ?? 0),
    }),
    {
      inputTokens: result.tokenUsage?.inputTokens ?? 0,
      outputTokens: result.tokenUsage?.outputTokens ?? 0,
      costUsd: result.tokenUsage?.costUsd ?? 0,
    },
  );
  result.tokenUsage = sumTokens;
  result.cachedTokenUsage = addUsage(result.cachedTokenUsage, ...partials.map((p) => p.cachedTokenUsage));
  return result;
}

async function condenseOne(
  relativePath: string,
  items: ChunkAnalysisResult[],
  llmCallContext?: AskLlmOptions,
): Promise<AnalyzedFileResult> {
  const serialized = serializeItems(items);
  const userPrompt = buildCondenseUserPrompt({ relativePath, serialized, count: items.length });
  try {
    const response = await askJsonLLM<Record<string, unknown>>(
      CONDENSE_SYSTEM_PROMPT,
      userPrompt,
      llmCallContext ?? {},
    );
    const condenseUsage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
    };
    const condenseCached = response.usage.cached === true ? { ...condenseUsage } : { ...ZERO_USAGE };
    if (response.result !== null) {
      const shaped = shapeAnalysis(response.result);
      shaped.tokenUsage = condenseUsage;
      shaped.cachedTokenUsage = condenseCached;
      return shaped;
    }
    logger.warn(`condenseOne: ${relativePath} unparseable JSON; falling back to dedup of ${items.length} items`);
    return {
      ...deterministicMerge(items),
      tokenUsage: condenseUsage,
      cachedTokenUsage: condenseCached,
    };
  } catch (cause: unknown) {
    if (cause instanceof LlmConfigError || cause instanceof LlmError) {
      throw cause;
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    logger.warn(`condenseOne: ${relativePath} askJsonLLM failed (${msg}); falling back to dedup`);
  }
  return deterministicMerge(items);
}

function deterministicMerge(items: ChunkAnalysisResult[]): AnalyzedFileResult {
  const language = items.find((i) => i.language !== FALLBACK_LANGUAGE)?.language ?? FALLBACK_LANGUAGE;
  const purposes = items.map((i) => i.analysis.purpose).filter((s) => s.length > 0);
  const summaries = items.map((i) => i.analysis.summary).filter((s) => s.length > 0);
  const contexts = items.map((i) => i.analysis.businessContext).filter((s) => s.length > 0);
  const analysis: FileAnalysis = {
    purpose: purposes.join(" | "),
    summary: summaries.join(" | "),
    businessContext: contexts.join(" "),
    classes: unique(items.flatMap((i) => i.analysis.classes)),
    functions: unique(items.flatMap((i) => i.analysis.functions)),
    importsInternal: unique(items.flatMap((i) => i.analysis.importsInternal)),
    importsExternal: unique(items.flatMap((i) => i.analysis.importsExternal)),
    keywords: unique(items.flatMap((i) => i.analysis.keywords)).slice(0, 10),
  };
  attachMergedArray(analysis, "ontologyConcepts", items);
  attachMergedArray(analysis, "businessEntities", items);
  attachMergedArray(analysis, "systemCapabilities", items);
  attachMergedArray(analysis, "sideEffects", items);
  attachMergedArray(analysis, "configDependencies", items);
  attachMergedArray(analysis, "integrationSurface", items);
  attachMergedArray(analysis, "contractsProvided", items);
  attachMergedArray(analysis, "contractsConsumed", items);
  const dataFlow = pickRepresentativeDataFlow(items);
  if (dataFlow.length > 0) {
    analysis.dataFlowDirection = dataFlow;
  }
  const sections = mergeSectionMaps(items);
  if (sections.length > 0) {
    analysis.sectionMap = sections;
  }
  return { language, analysis };
}

const EXTENDED_ARRAY_CAP = 8;

const EXTENDED_ARRAY_KEYS = [
  "ontologyConcepts",
  "businessEntities",
  "systemCapabilities",
  "sideEffects",
  "configDependencies",
  "integrationSurface",
  "contractsProvided",
  "contractsConsumed",
] as const;

type ExtendedArrayKey = (typeof EXTENDED_ARRAY_KEYS)[number];

function attachMergedArray(analysis: FileAnalysis, key: ExtendedArrayKey, items: ChunkAnalysisResult[]): void {
  const merged = unique(items.flatMap((i) => i.analysis[key] ?? [])).slice(0, EXTENDED_ARRAY_CAP);
  if (merged.length > 0) {
    analysis[key] = merged;
  }
}

function pickRepresentativeDataFlow(items: ChunkAnalysisResult[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const v = item.analysis.dataFlowDirection;
    if (typeof v === "string" && v.length > 0) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return "";
  }
  if (counts.size > 1) {
    return "internal";
  }
  return [...counts.keys()][0] ?? "";
}

function mergeSectionMaps(items: ChunkAnalysisResult[]): FileAnalysisSection[] {
  const seen = new Set<string>();
  const out: FileAnalysisSection[] = [];
  for (const item of items) {
    const sections = item.analysis.sectionMap;
    if (sections === undefined) {
      continue;
    }
    for (const section of sections) {
      const key = `${section.name} ${section.description}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(section);
    }
  }
  return out;
}

function toChunkResult(r: AnalyzedFileResult): ChunkAnalysisResult {
  return {
    relativePath: "",
    chunkIndex: 0,
    totalChunks: 0,
    startLine: 0,
    endLine: 0,
    language: r.language,
    analysis: r.analysis,
    tokenUsage: r.tokenUsage,
    cachedTokenUsage: r.cachedTokenUsage,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

function batchByTokenBudget(items: ChunkAnalysisResult[], budget: number): ChunkAnalysisResult[][] {
  const batches: ChunkAnalysisResult[][] = [];
  let current: ChunkAnalysisResult[] = [];
  let currentTokens = 0;
  for (const item of items) {
    const itemTokens = tokenLen(serializeItem(item));
    if (currentTokens + itemTokens > budget && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += itemTokens;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function serializeItems(items: ChunkAnalysisResult[]): string {
  return items.map((it, i) => `--- Item ${i + 1} ---\n${serializeItem(it)}`).join("\n\n");
}

function serializeItem(item: ChunkAnalysisResult): string {
  const a = item.analysis;
  const lines = [
    `language: ${item.language}`,
    `lines: ${item.startLine}-${item.endLine}`,
    `purpose: ${a.purpose}`,
    `summary: ${a.summary}`,
    `businessContext: ${a.businessContext}`,
    `classes: ${JSON.stringify(a.classes)}`,
    `functions: ${JSON.stringify(a.functions)}`,
    `importsInternal: ${JSON.stringify(a.importsInternal)}`,
    `importsExternal: ${JSON.stringify(a.importsExternal)}`,
    `keywords: ${JSON.stringify(a.keywords)}`,
  ];
  for (const key of EXTENDED_ARRAY_KEYS) {
    const value = a[key];
    if (value !== undefined && value.length > 0) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  if (typeof a.dataFlowDirection === "string" && a.dataFlowDirection.length > 0) {
    lines.push(`dataFlowDirection: ${a.dataFlowDirection}`);
  }
  if (a.sectionMap !== undefined && a.sectionMap.length > 0) {
    lines.push(`sectionMap: ${JSON.stringify(a.sectionMap)}`);
  }
  return lines.join("\n");
}
