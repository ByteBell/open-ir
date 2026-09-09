import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import { logger } from "@bb/logger";
import type { FileAnalyzer } from "@bb/ingest-core";
import type { IngestStrategy, StrategyInput, StrategyResult } from "@bb/ingest-core";
import { throwIfCancelled } from "@bb/ingest-core";
import { withConcurrency } from "@bb/ingest-core";
import { scanAndClassify } from "@bb/ingest-core";
import { analyseSmallFiles } from "@bb/ingest-core";
import { analyseBigFiles } from "@bb/ingest-core";
import { writeEligibleFiles } from "@bb/ingest-core";
import { backfillMissingFields } from "@bb/ingest-core";
import { FileAnalysisCache } from "@bb/ingest-core";
import { runFolderSummaryPhase } from "./folder-summary.ts";
import { makeRepoSummaryEnvelope, persistRepoSummary, summariseRepo } from "./repo-summary.ts";
import { storeFlatAnalysis } from "./phases/store-flat-analysis.ts";
import type { ProgressContext, ProgressContextFactory } from "@bb/ingest-core";
import { nullProgressContextFactory } from "@bb/ingest-core";

export interface FlatFolderStrategyDeps {
  fileAnalyzer: FileAnalyzer;
  progressContextFactory?: ProgressContextFactory;
}

export function createFlatFolderStrategy(deps: FlatFolderStrategyDeps): IngestStrategy {
  const progressContextFactory = deps.progressContextFactory ?? nullProgressContextFactory;
  return {
    name: "flat-folder",
    // Failures propagate to the pipeline runner + queue finalizer, which own the
    // HALTED-vs-FAILED decision and outcome SSE. The strategy never catches to
    // emit terminal state itself — it just lets the error surface.
    async execute(input: StrategyInput): Promise<StrategyResult> {
      const { context, source, archiveSink, metaPaths, payload, branch, usageGuard } = input;
      const { knowledgeId, orgId, repoId, llmCallContext, ignoreSets } = context;
      const progressContext: ProgressContext = progressContextFactory(knowledgeId);

      // Shared LLM limiter — small-file analyses, big-file chunk analyses,
      // and per-file condense calls all check out from this single pool.
      const llmConcurrency = getConfigValue(Config.LlmConcurrency);
      const limiter = withConcurrency(llmConcurrency);

      progressContext.phaseChanged("scan");
      logger.info(`flat-folder: phase1 (scan + classify) starting for ${knowledgeId} limit=${llmConcurrency}`);
      throwIfCancelled(knowledgeId);
      const scanInput: Parameters<typeof scanAndClassify>[0] = {
        knowledgeId,
        source,
        metaPaths,
        limiter,
        progressContext,
      };
      if (llmCallContext !== undefined) {
        scanInput.llmCallContext = llmCallContext;
      }
      if (ignoreSets !== undefined) {
        scanInput.ignoreSets = ignoreSets;
      }
      const { manifest } = await scanAndClassify(scanInput);

      // Persist the canonical eligible-files list BEFORE any small- or
      // big-file LLM call runs. Read back by `@plumbline/knowledge-validation`
      // to verify every file the analyzer was asked to process landed in
      // Neo4j. Must be the last step before analysis dispatch — if this
      // fails, the knowledge is not validatable post-hoc and we'd rather
      // fail the run than ship an un-checkable index.
      const eligibleInput: Parameters<typeof writeEligibleFiles>[0] = {
        knowledgeId,
        manifest,
        source,
      };
      if (archiveSink !== undefined) {
        eligibleInput.archiveSink = archiveSink;
      }
      await writeEligibleFiles(eligibleInput);

      progressContext.phaseChanged("file_analysis");
      logger.info(
        `flat-folder: phase2 (analyse small ${manifest.summary.smallCount} + big ${manifest.summary.bigCount}) starting in parallel`,
      );
      throwIfCancelled(knowledgeId);
      const smallInput: Parameters<typeof analyseSmallFiles>[0] = {
        knowledgeId,
        manifest,
        source,
        metaPaths,
        analyzer: deps.fileAnalyzer,
        limiter,
        progressContext,
      };
      if (archiveSink !== undefined) {
        smallInput.archiveSink = archiveSink;
      }
      if (llmCallContext !== undefined) {
        smallInput.llmCallContext = llmCallContext;
      }
      const bigInput: Parameters<typeof analyseBigFiles>[0] = {
        knowledgeId,
        manifest,
        source,
        metaPaths,
        limiter,
        progressContext,
      };
      if (llmCallContext !== undefined) {
        bigInput.llmCallContext = llmCallContext;
      }
      const [smallResult, bigResult] = await Promise.all([analyseSmallFiles(smallInput), analyseBigFiles(bigInput)]);
      let totalInputTokens = smallResult.tokenUsage.inputTokens + bigResult.tokenUsage.inputTokens;
      let totalOutputTokens = smallResult.tokenUsage.outputTokens + bigResult.tokenUsage.outputTokens;
      let totalCostUsd = smallResult.tokenUsage.costUsd + bigResult.tokenUsage.costUsd;
      let cachedInputTokens = smallResult.cachedTokenUsage.inputTokens + bigResult.cachedTokenUsage.inputTokens;
      let cachedOutputTokens = smallResult.cachedTokenUsage.outputTokens + bigResult.cachedTokenUsage.outputTokens;
      let cachedCostUsd = smallResult.cachedTokenUsage.costUsd + bigResult.cachedTokenUsage.costUsd;
      // The usage guard meters BILLABLE (fresh = total − cached) usage only;
      // cached tokens incurred no fresh provider spend.
      const freshUsage = (): { inputTokens: number; outputTokens: number; costUsd: number } => ({
        inputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
        outputTokens: Math.max(0, totalOutputTokens - cachedOutputTokens),
        costUsd: Math.max(0, totalCostUsd - cachedCostUsd),
      });
      await usageGuard?.onPhaseComplete("file_analysis", freshUsage());

      logger.info(`flat-folder: loading file-analysis cache`);
      throwIfCancelled(knowledgeId);
      const fileAnalysisCache = await FileAnalysisCache.loadAll(metaPaths);

      logger.info(`flat-folder: phase3 (backfill missing fields) starting`);
      throwIfCancelled(knowledgeId);
      const backfill = await backfillMissingFields(
        metaPaths,
        fileAnalysisCache,
        limiter,
        llmCallContext,
        progressContext,
      );
      totalInputTokens += backfill.tokenUsage.inputTokens;
      totalOutputTokens += backfill.tokenUsage.outputTokens;
      totalCostUsd += backfill.tokenUsage.costUsd;
      cachedInputTokens += backfill.cachedTokenUsage.inputTokens;
      cachedOutputTokens += backfill.cachedTokenUsage.outputTokens;
      cachedCostUsd += backfill.cachedTokenUsage.costUsd;

      progressContext.phaseChanged("folder_analysis");
      logger.info(`flat-folder: phase5 (folder summaries) starting`);
      throwIfCancelled(knowledgeId);
      const phase5 = await runFolderSummaryPhase(
        knowledgeId,
        metaPaths,
        fileAnalysisCache,
        limiter,
        llmCallContext,
        progressContext,
      );
      totalInputTokens += phase5.tokenUsage.inputTokens;
      totalOutputTokens += phase5.tokenUsage.outputTokens;
      totalCostUsd += phase5.tokenUsage.costUsd;
      cachedInputTokens += phase5.cachedTokenUsage.inputTokens;
      cachedOutputTokens += phase5.cachedTokenUsage.outputTokens;
      cachedCostUsd += phase5.cachedTokenUsage.costUsd;
      await usageGuard?.onPhaseComplete("folder_analysis", freshUsage());

      progressContext.phaseChanged("indexing");
      logger.info(`flat-folder: phase6 (repo summary) starting`);
      throwIfCancelled(knowledgeId);
      const {
        summary: repoSummary,
        tokenUsage: repoUsage,
        cachedTokenUsage: repoCached,
      } = await summariseRepo(knowledgeId, metaPaths, llmCallContext);
      totalInputTokens += repoUsage.inputTokens;
      totalOutputTokens += repoUsage.outputTokens;
      totalCostUsd += repoUsage.costUsd;
      cachedInputTokens += repoCached.inputTokens;
      cachedOutputTokens += repoCached.outputTokens;
      cachedCostUsd += repoCached.costUsd;
      await usageGuard?.onPhaseComplete("repo_summary", freshUsage());
      let repoSummarised = false;
      if (repoSummary !== null) {
        await persistRepoSummary(metaPaths, makeRepoSummaryEnvelope(knowledgeId, orgId, repoSummary));
        repoSummarised = true;
      }

      logger.info(`flat-folder: phase7 (graph store) starting`);
      throwIfCancelled(knowledgeId);
      const phase7 = await storeFlatAnalysis({
        scope: { orgId, knowledgeId, repoId },
        payload,
        branch,
        owner: context.owner,
        repo: context.repo,
        commitHash: context.commitHash,
        metaPaths,
        cache: fileAnalysisCache,
        progressContext,
      });

      progressContext.completed();

      return {
        filesAnalyzed:
          smallResult.smallFilesAnalysed + smallResult.oversizedStubs + bigResult.processed + bigResult.cached,
        foldersSummarised: phase5.succeeded,
        repoSummarised,
        graphNodesWritten: phase7.nodesWritten,
        tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd: totalCostUsd },
        cachedTokenUsage: {
          inputTokens: cachedInputTokens,
          outputTokens: cachedOutputTokens,
          costUsd: cachedCostUsd,
        },
      };
    },
  };
}
