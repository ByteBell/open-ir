import { randomUUID } from "node:crypto";
import { Config } from "@bb/types";
import type { AskLlmOptions } from "@bb/llm";
import { getConfigValue } from "@bb/config";
import { logger } from "@bb/logger";
import { LlmConfigError, LlmError } from "@bb/errors";
import type { EnrichmentFailure, EnrichmentFailureReason, NodeScope } from "@bb/types";
import { enrichmentDb } from "@bb/db";
import { throwIfCancelled, CancellationError } from "@bb/ingest-core";
import { withConcurrency } from "@bb/ingest-core";
import type { MetaPaths } from "@bb/ingest-core";
import type { ProgressContext } from "@bb/ingest-core";
import type { FileAnalysisCache } from "@bb/ingest-core";
import { enrichmentArtifactExists, enrichmentArtifactLayout } from "#src/concept-graph/enrichment-artifact.ts";
import { buildEnrichmentToolCatalog, buildEnrichmentToolExecutor } from "#src/concept-graph/mcp-tool-executor.ts";
import { buildEnrichFileSystemPrompt } from "#src/concept-graph/prompts/enrich-file.ts";
import { EnrichmentRegistry } from "#src/concept-graph/phases/enrichment-registry.ts";
import { enrichOneFile, type EnrichOneFileInput } from "#src/concept-graph/phases/enrich-one-file.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 driver: per-file MCP-driven enrichment. One LLM call per file
// (in parallel under `Config.EnrichmentConcurrency`), each call equipped
// with MCP tools and capped on iterations / tool-calls / wall-time. The
// LLM emits a strict-Zod-validated JSON object; on success we upsert
// :Concept / :Contract / :Guidepost nodes + edges in idempotent batches.
//
// Resume protocol: `KnowledgeDoc.completedFiles[]` lists files that
// finished successfully in the current run. We skip those. A fresh
// enrichment run (`startEnrichmentRun` with a new UUID) clears the list.
//
// Failure semantics: no fallback. Any file that hits a cap, fails schema
// validation, or has a provider error is recorded in
// `enrichmentFailures[]` and the strategy throws at the end if anything
// remains unenriched — the queue retry policy picks up.
// ─────────────────────────────────────────────────────────────────────────────

export interface EnrichFilesInput {
  scope: NodeScope;
  metaPaths: MetaPaths;
  cache: FileAnalysisCache;
  commitId: string;
  llmCallContext?: AskLlmOptions;
  progressContext?: ProgressContext;
}

export interface EnrichFilesResult {
  enrichmentRunId: string;
  filesEnriched: number;
  filesFailed: number;
  tokenUsage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export async function enrichFiles(input: EnrichFilesInput): Promise<EnrichFilesResult> {
  const enrichmentRunId = randomUUID();
  const enrichmentModel = getConfigValue(Config.EnrichmentModel);
  if (enrichmentModel.length === 0) {
    throw new LlmConfigError("plumbline set enrichment.model <model-id>");
  }
  await enrichmentDb.startEnrichmentRun(input.scope.knowledgeId, enrichmentRunId);

  const concurrency = getConfigValue(Config.EnrichmentConcurrency);
  const maxToolCalls = getConfigValue(Config.EnrichmentMaxToolCallsPerFile);
  const maxIterations = getConfigValue(Config.EnrichmentMaxIterationsPerFile);
  const wallTimeMs = getConfigValue(Config.EnrichmentWallTimeMsPerFile);
  const maxToolResultChars = getConfigValue(Config.EnrichmentMaxToolResultChars);

  const limiter = withConcurrency(concurrency);
  // `metaPaths.metaOutputRoot` is already commit-scoped under the kube-v2 layout;
  // the artifact layout no longer needs a separate commit id argument.
  const layout = enrichmentArtifactLayout(input.metaPaths);
  const registry = new EnrichmentRegistry();
  const tools = buildEnrichmentToolCatalog();
  const executor = buildEnrichmentToolExecutor({ knowledgeId: input.scope.knowledgeId });
  const systemPrompt = buildEnrichFileSystemPrompt();

  // Resume: union of (a) the ledger's `completedFiles[]` from prior attempts and
  // (b) on-disk artifacts under `meta-output/enrichment/`. Either is
  // sufficient evidence the file was successfully enriched. The disk check
  // is the canonical source of truth — `completedFiles[]` mirrors it.
  // Pre-filter the work queue so already-enriched files never reach the LLM.
  const allFiles = Array.from(input.cache.values());
  const completedFromLedger = new Set(await enrichmentDb.getCompletedEnrichmentFiles(input.scope.knowledgeId));
  const filesToEnrich: typeof allFiles = [];
  let resumedFromPriorRun = 0;
  for (const file of allFiles) {
    if (completedFromLedger.has(file.relativePath)) {
      resumedFromPriorRun += 1;
      continue;
    }
    if (await enrichmentArtifactExists(layout, file.relativePath)) {
      // Disk says done but the ledger doesn't — reconcile so subsequent
      // retries hit the cheap ledger check first.
      await enrichmentDb.markFileEnriched(input.scope.knowledgeId, file.relativePath);
      resumedFromPriorRun += 1;
      continue;
    }
    filesToEnrich.push(file);
  }
  if (resumedFromPriorRun > 0) {
    logger.info(
      `concept-graph: resuming enrichment — skipping ${resumedFromPriorRun} already-enriched file(s); ${filesToEnrich.length} remaining`,
    );
  }

  const reporter = input.progressContext?.reporter({
    phase: "enrichment",
    total: { kind: "fixed", total: allFiles.length },
  });
  await reporter?.start();
  if (resumedFromPriorRun > 0) {
    reporter?.increment(resumedFromPriorRun);
  }

  const cumulativeUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let filesEnriched = resumedFromPriorRun;
  let filesFailed = 0;
  const failedPaths: string[] = [];

  try {
    await Promise.all(
      filesToEnrich.map((file) =>
        limiter(async () => {
          throwIfCancelled(input.scope.knowledgeId);
          try {
            const oneFileInput: EnrichOneFileInput = {
              file,
              scope: input.scope,
              enrichmentRunId,
              systemPrompt,
              registry,
              tools,
              executor,
              enrichmentModel,
              maxToolCalls,
              maxIterations,
              wallTimeMs,
              maxToolResultChars,
              layout,
              commitId: input.commitId,
            };
            if (input.llmCallContext !== undefined) {
              oneFileInput.llmCallContext = input.llmCallContext;
            }
            const usage = await enrichOneFile(oneFileInput);
            cumulativeUsage.inputTokens += usage.inputTokens;
            cumulativeUsage.outputTokens += usage.outputTokens;
            cumulativeUsage.costUsd += usage.costUsd;
            await enrichmentDb.markFileEnriched(input.scope.knowledgeId, file.relativePath);
            filesEnriched += 1;
            reporter?.increment(1, { fileName: file.relativePath });
          } catch (cause: unknown) {
            if (cause instanceof CancellationError) {
              throw cause;
            }
            const reason = classifyEnrichmentError(cause);
            const failure: EnrichmentFailure = {
              filePath: file.relativePath,
              reason,
              attemptCount: 1,
              lastError: cause instanceof Error ? cause.message : String(cause),
              lastAttemptAt: new Date(),
            };
            await enrichmentDb.recordEnrichmentFailure(input.scope.knowledgeId, failure);
            filesFailed += 1;
            failedPaths.push(file.relativePath);
            logger.warn(
              `concept-graph: enrich failed for ${file.relativePath} (${reason}): ${failure.lastError.slice(0, 200)}`,
            );
            // Count failures toward progress so the reporter's total matches at the end.
            reporter?.increment(1, { fileName: file.relativePath });
          }
        }),
      ),
    );
  } finally {
    reporter?.stop();
  }

  if (filesFailed > 0) {
    await enrichmentDb.failEnrichmentRun(input.scope.knowledgeId);
    const head = failedPaths.slice(0, 5).join(", ");
    const more = failedPaths.length > 5 ? ` (+${failedPaths.length - 5} more)` : "";
    throw new LlmError(`concept-graph: ${filesFailed} file(s) failed enrichment: ${head}${more}`);
  }

  await enrichmentDb.completeEnrichmentRun(input.scope.knowledgeId);
  return { enrichmentRunId, filesEnriched, filesFailed, tokenUsage: cumulativeUsage };
}

function classifyEnrichmentError(cause: unknown): EnrichmentFailureReason {
  if (cause instanceof LlmError) {
    if (cause.message.includes("did not complete")) {
      return "cap-exceeded";
    }
    if (cause.message.includes("schema validation") || cause.message.includes("not valid JSON")) {
      return "validation-failed";
    }
    return "provider-error";
  }
  return "provider-error";
}
