import { KnowledgeState } from "@bb/types";
import type {
  KnowledgeDoc,
  KnowledgeFailureCategory,
  StatsResponse,
  ActivityInput,
  FileAnalysisSection,
  FileAnalysis,
  RawFileDoc,
  KnowledgeListEntry,
  DeleteKnowledgeResult,
  DbPingResult,
  EnrichmentFailure,
} from "@bb/types";

export type { FileAnalysisSection, FileAnalysis, RawFileDoc, KnowledgeListEntry, DeleteKnowledgeResult, DbPingResult };

/** Optional phase metadata persisted alongside file counts by `updateKnowledgeProgress`. */
export interface KnowledgeProgressExtra {
  /** Phase-weighted overall progress (0–100). */
  progressPercent?: number;
  /** Name of the phase currently executing. */
  currentPhase?: string;
}

export interface IKnowledgeRepository {
  setKnowledgeState(knowledgeId: string, state: KnowledgeState): Promise<void>;
  /**
   * Sets `source.commitId` on the knowledge doc without touching the
   * `source.commitHashes` history array. Called early in the pipeline (after
   * the clone resolves a SHA, before the strategy executes) so MCP tools
   * invoked during enrichment can resolve the on-disk clone dir via the
   * commit-scoped path layout. The history entry (with real token usage) is
   * appended later by `setKnowledgeCommit`.
   */
  setKnowledgeCommitHead(knowledgeId: string, commitHash: string): Promise<void>;
  setKnowledgeCommit(
    knowledgeId: string,
    commitHash: string,
    inputTokens?: string,
    outputTokens?: string,
    costUsd?: string,
    cachedInputTokens?: string,
    cachedOutputTokens?: string,
    cachedCostUsd?: string,
  ): Promise<void>;
  setKnowledgeBranch(knowledgeId: string, branch: string): Promise<void>;
  updateKnowledgeProgress(
    knowledgeId: string,
    processedFiles: number,
    totalFiles?: number,
    extra?: KnowledgeProgressExtra,
  ): Promise<void>;
  upsertKnowledge(doc: Omit<KnowledgeDoc, "updatedAt"> & { updatedAt?: Date }): Promise<void>;
  deleteKnowledge(knowledgeId: string): Promise<DeleteKnowledgeResult>;
  listKnowledge(opts?: { limit?: number }): Promise<KnowledgeListEntry[]>;
  getKnowledge(knowledgeId: string): Promise<KnowledgeListEntry | null>;
  markKnowledgeFailed(
    knowledgeId: string,
    reason: string,
    category: KnowledgeFailureCategory,
    detail?: string,
  ): Promise<void>;
  /**
   * Marks a knowledge as HALTED (transient failure, auto-retry pending) and
   * records the same structured `failure` subdoc as `markKnowledgeFailed`.
   * Non-terminal — the queue finalizer promotes HALTED → FAILED via
   * `promoteHaltedToFailed` once retries are exhausted.
   */
  markKnowledgeHalted(
    knowledgeId: string,
    reason: string,
    category: KnowledgeFailureCategory,
    detail?: string,
  ): Promise<void>;
  /**
   * Promotes a HALTED knowledge to terminal FAILED, preserving the `failure`
   * subdoc recorded at HALT time. Scoped to `status.state === "HALTED"` so it
   * is idempotent. Resolves to `true` when a document was promoted.
   */
  promoteHaltedToFailed(knowledgeId: string): Promise<boolean>;
  /**
   * Marks a knowledge as terminal CORRUPTED (source repo gone/inaccessible) and
   * records the structured `failure` subdoc, mirroring `markKnowledgeFailed`.
   * Used for the `repo_unavailable` category so the auto-pull sweep (which
   * selects only `PROCESSED`) stops re-pulling a dead repo. The indexed data
   * stays queryable; recovery is a re-point/re-ingest.
   */
  markKnowledgeCorrupted(
    knowledgeId: string,
    reason: string,
    category: KnowledgeFailureCategory,
    detail?: string,
  ): Promise<void>;
}

export interface IRawRepository {
  upsertRawFile(doc: Omit<RawFileDoc, "updatedAt">): Promise<void>;
  listRawFileShas(knowledgeId: string): Promise<Map<string, string>>;
  deleteRawFiles(knowledgeId: string, relativePaths: string[]): Promise<number>;
}

export interface IAggregateStatsRepository {
  aggregateStats(): Promise<StatsResponse>;
}

export interface IActivityRepository {
  recordActivity(activity: ActivityInput): Promise<void>;
}

export interface IUsageRepository {
  incrementUsage(identityId: string, inputTokenCount?: number, outputTokenCount?: number): Promise<void>;
  getMonthlyUsage(year: number, month: number): Promise<unknown[]>;
  getGlobalUsage(): Promise<unknown[]>;
}

/**
 * Per-file enrichment ledger for the concept-graph strategy. The state lives on
 * the existing knowledge document — no separate entity — and exists so a queue
 * retry can resume by skipping files that already completed. The knowledge's
 * own `KnowledgeState` stays PROCESSING throughout; this ledger is the
 * finer-grained cursor underneath it.
 *
 * Every method throws `KnowledgeNotFoundError` when the document is missing.
 */
export interface IEnrichmentRepository {
  /**
   * Begins or resumes an enrichment attempt: stamps `runId`, clears recorded
   * failures (failed files are re-evaluated on the retry) and moves the ledger
   * to `Running`. `completedFiles` is preserved so a retry skips finished work
   * — a clean re-enrichment is an explicit reset, not a retry.
   */
  startEnrichmentRun(knowledgeId: string, runId: string): Promise<void>;
  /** Files already enriched, used to pre-filter the work queue on resume. */
  getCompletedEnrichmentFiles(knowledgeId: string): Promise<string[]>;
  /** Records `filePath` as enriched. Idempotent — a repeat does not duplicate. */
  markFileEnriched(knowledgeId: string, filePath: string): Promise<void>;
  /**
   * Records or replaces the failure entry for `failure.filePath` (one entry per
   * file). Diagnostic only — the strategy decides the overall outcome.
   */
  recordEnrichmentFailure(knowledgeId: string, failure: EnrichmentFailure): Promise<void>;
  /** Moves the ledger to `Completed`. The caller transitions `KnowledgeState`. */
  completeEnrichmentRun(knowledgeId: string): Promise<void>;
  /** Moves the ledger to `Failed`. A fresh `startEnrichmentRun` retries it. */
  failEnrichmentRun(knowledgeId: string): Promise<void>;
}

export interface IDocumentDatabaseProvider {
  knowledge: IKnowledgeRepository;
  raw: IRawRepository;
  stats: IAggregateStatsRepository;
  activity: IActivityRepository;
  usage: IUsageRepository;
  enrichment: IEnrichmentRepository;

  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<DbPingResult>;
}
