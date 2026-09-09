import type { FileAnalysis } from "@bb/db-core";
import { basename } from "./pathUtils.ts";

/** Public input shape for `upsertFileNode` / `upsertFileNodesBatch`. */
export interface UpsertFileNodeInput {
  orgId?: string;
  knowledgeId: string;
  repoId?: string;
  relativePath: string;
  language: string;
  sha: string;
  sizeBytes: number;
  analysis: FileAnalysis;
  folderPath?: string;
  isBigFile?: boolean;
  totalChunks?: number;
  totalTokenCount?: number;
  /** Display name (owner/repo) used on the :FileNode legacy mirror. */
  repoName?: string;
  /** Branch name used on the :FileNode legacy mirror. */
  branch?: string;
}

/** Internal: identity tuple used for batched clear/attach lookups. */
export interface FileRow {
  knowledgeId: string;
  relativePath: string;
}

/**
 * Build the param row for one file's MERGE. Used by both the single-shot
 * upsertFileNode call (`_runCypher`) and the batched UNWIND
 * (`_runInTransaction`); kept in one place so the param keys stay in lockstep
 * with the Cypher in [filesCypher.ts](filesCypher.ts) /
 * [filesCypherBatch.ts](filesCypherBatch.ts).
 */
export function fileRowFor(input: UpsertFileNodeInput): Record<string, unknown> {
  const sectionMap = input.analysis.sectionMap ?? [];
  const orgId = input.orgId ?? "local";
  const repoName = input.repoName ?? "";
  const branchName = input.branch ?? "";
  return {
    knowledgeId: input.knowledgeId,
    relativePath: input.relativePath,
    orgId,
    repoId: input.repoId ?? input.knowledgeId,
    language: input.language,
    sha: input.sha,
    sizeBytes: input.sizeBytes,
    purpose: input.analysis.purpose,
    summary: input.analysis.summary,
    businessContext: input.analysis.businessContext,
    dataFlowDirection: input.analysis.dataFlowDirection ?? "",
    ontologyConcepts: input.analysis.ontologyConcepts ?? [],
    businessEntities: input.analysis.businessEntities ?? [],
    systemCapabilities: input.analysis.systemCapabilities ?? [],
    sideEffects: input.analysis.sideEffects ?? [],
    configDependencies: input.analysis.configDependencies ?? [],
    integrationSurface: input.analysis.integrationSurface ?? [],
    contractsProvided: input.analysis.contractsProvided ?? [],
    contractsConsumed: input.analysis.contractsConsumed ?? [],
    sectionNames: sectionMap.map((s) => s.name),
    sectionDescriptions: sectionMap.map((s) => s.description),
    sectionMapJson: JSON.stringify(sectionMap),
    keywords: input.analysis.keywords ?? [],
    classes: input.analysis.classes ?? [],
    functions: input.analysis.functions ?? [],
    importsInternal: input.analysis.importsInternal ?? [],
    importsExternal: input.analysis.importsExternal ?? [],
    isBigFile: input.isBigFile ?? false,
    totalChunks: input.totalChunks ?? 0,
    totalTokenCount: input.totalTokenCount ?? 0,
    nodeId: `${input.knowledgeId}::${input.relativePath}`,
    name: basename(input.relativePath),
    repoName,
    branchName,
  };
}

/**
 * Flatten one input field (an analysis array such as `keywords` or `classes`)
 * across a batch of files into per-edge tuples. Used to build the params for
 * BATCH_ATTACH_KEYWORDS / BATCH_ATTACH_CLASSES / …
 */
export function flattenPairs(
  inputs: readonly UpsertFileNodeInput[],
  field: "keywords" | "classes" | "functions" | "importsInternal" | "importsExternal",
  valueKey: "name" | "signature",
  normalize?: (v: string) => string,
): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const input of inputs) {
    const values = input.analysis[field];
    if (!Array.isArray(values)) {
      continue;
    }
    for (const raw of values) {
      const value = normalize !== undefined ? normalize(raw) : raw;
      out.push({ knowledgeId: input.knowledgeId, relativePath: input.relativePath, [valueKey]: value });
    }
  }
  return out;
}
