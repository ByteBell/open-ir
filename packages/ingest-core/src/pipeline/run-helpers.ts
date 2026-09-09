import {
  KnowledgeState,
  type GithubIndexPayload,
  type KnowledgeFailureCategory,
  type LocalIngestPayload,
} from "@bb/types";
import { knowledgeDb } from "@bb/db";
import { knowledgeGraph } from "@bb/graph-db";

/**
 * Persists the FAILED state + structured failure reason to the document store, then
 * mirrors the state into Neo4j on a best-effort basis. Errors from both
 * sides are swallowed so the throw path is preserved.
 *
 * Extracted from `run.ts` so `runGithub` and `runLocal` (now in `run-local.ts`)
 * share one implementation.
 */
export async function persistFailure(
  knowledgeId: string,
  category: KnowledgeFailureCategory,
  reason: string,
  detail?: string,
): Promise<void> {
  await knowledgeDb.markKnowledgeFailed(knowledgeId, reason, category, detail).catch(() => undefined);
  await knowledgeGraph.setKnowledgeStateInGraph(knowledgeId, KnowledgeState.Failed).catch(() => undefined);
}

/**
 * Persists the non-terminal HALTED state + structured failure reason to the store,
 * then mirrors the state into Neo4j (best-effort). Used by the pipeline catch
 * paths for *transient* failures, where the queue retry mechanism will retry
 * the job and — only on exhaustion — promote HALTED → FAILED. Mirrors
 * `persistFailure` so the throw path is preserved.
 */
export async function persistHalted(
  knowledgeId: string,
  category: KnowledgeFailureCategory,
  reason: string,
  detail?: string,
): Promise<void> {
  await knowledgeDb.markKnowledgeHalted(knowledgeId, reason, category, detail).catch(() => undefined);
  await knowledgeGraph.setKnowledgeStateInGraph(knowledgeId, KnowledgeState.Halted).catch(() => undefined);
}

/**
 * Persists the terminal CORRUPTED state + structured failure reason to the store,
 * then mirrors it into Neo4j (best-effort). Used for the `repo_unavailable`
 * category: the source repo is gone/inaccessible, so the row leaves PROCESSED
 * and the auto-pull sweep stops re-pulling it. Mirrors `persistFailure` so the
 * throw path is preserved.
 */
export async function persistCorrupted(
  knowledgeId: string,
  category: KnowledgeFailureCategory,
  reason: string,
  detail?: string,
): Promise<void> {
  await knowledgeDb.markKnowledgeCorrupted(knowledgeId, reason, category, detail).catch(() => undefined);
  await knowledgeGraph.setKnowledgeStateInGraph(knowledgeId, KnowledgeState.Corrupted).catch(() => undefined);
}

/**
 * Stamps `retryable = false` on a thrown error. Property contract read by the
 * queue worker wrappers to convert the failure into an unrecoverable error —
 * stopping further
 * automatic attempts. Used for non-retryable failures the pipeline has already
 * moved to terminal FAILED. Duck-typed (no cross-tier import) by the queue.
 */
export function markNonRetryable<E extends object>(err: E): E {
  (err as { retryable?: boolean }).retryable = false;
  return err;
}

/** Type guard discriminating `GithubIndexPayload` from `LocalIngestPayload`. */
export function isGithubPayload(payload: GithubIndexPayload | LocalIngestPayload): payload is GithubIndexPayload {
  return (payload as GithubIndexPayload).repoUrl !== undefined;
}
