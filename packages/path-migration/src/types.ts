import type { KnowledgeDoc } from "@bb/types";

/** Outcome of a legacy on-disk layout reconciliation. */
export interface MigrationSummary {
  /** Entries moved into the commit-scoped layout (e.g. "<id> (clone)"). */
  migrated: string[];
  /** Knowledge present in the DB but skipped — no commitId to derive a target. */
  skippedNoCommit: string[];
  /** Knowledge present in the DB but skipped — no info.repoUrl to derive a target. */
  skippedNoRepoUrl: string[];
  /** Targets already present in the new layout; left untouched. */
  skippedAlready: string[];
  /**
   * Legacy directories with no backing DB record. They can never be migrated
   * (no doc to derive a target), so they are deleted — or, under `dryRun`,
   * reported as would-be-deleted. Callers surface these so the operator knows
   * the knowledge was dropped.
   */
  abandoned: string[];
  /** Per-knowledge failures during the move. */
  failed: Array<{ knowledgeId: string; reason: string }>;
}

export interface MigrateLegacyPathsInput {
  /** Plumbline home directory (e.g. `~/.plumbline`). */
  home: string;
  /** Single-tenant org id (`local`). */
  orgId: string;
  /** Every knowledge known to the DB. Drives which legacy dirs are recoverable. */
  knowledgeDocs: readonly KnowledgeDoc[];
  /** When true, compute the plan and report it without touching disk. */
  dryRun: boolean;
}
