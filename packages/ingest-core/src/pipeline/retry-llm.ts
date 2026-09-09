import { LlmConfigError, LlmError } from "@bb/errors";
import { logger } from "@bb/logger";
import { CancellationError } from "#src/pipeline/cancellation.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Bounded retry for a single LLM-backed operation. Used by every phase that
// makes per-unit LLM calls (file analysis, big-file chunks, folder summaries,
// repo summary, enrichment) so a transient network blip on one unit does not
// kill its enclosing batch.
//
// Retry policy:
//   - Up to MAX_ATTEMPTS (3 by default) total attempts per unit
//   - Linear backoff: 1500ms × attempt number
//   - Transient errors (LlmError, generic errors, etc.) are retried
//   - LlmConfigError and CancellationError propagate immediately — retrying
//     them is pointless (bad config / cancelled job)
//
// Callers wrap a single LLM call (or a small LLM-bound subgraph) in this
// helper, then handle the final thrown error themselves — typically by
// counting the unit as "failed" and continuing with the rest of the batch,
// so the batch-level retry (the queue) can resume from disk on the next attempt.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_LLM_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 1500;

export interface RetryLlmCallOptions {
  /** Short label used in retry logs. e.g. "analyse-small" or "enrich" */
  phase: string;
  /** Unit identifier (file path, folder path, chunk id) — appears in logs. */
  unit: string;
  /** Optional overrides — defaults to MAX_LLM_ATTEMPTS / RETRY_BACKOFF_MS. */
  maxAttempts?: number;
  backoffMs?: number;
}

export async function retryLlmCall<T>(op: () => Promise<T>, opts: RetryLlmCallOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_LLM_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? RETRY_BACKOFF_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await op();
    } catch (cause: unknown) {
      if (cause instanceof CancellationError || cause instanceof LlmConfigError) {
        throw cause;
      }
      lastError = cause;
      if (attempt < maxAttempts) {
        const wait = backoffMs * attempt;
        logger.warn(
          `${opts.phase}: ${opts.unit} attempt ${attempt}/${maxAttempts} failed (${describe(cause)}); retrying in ${wait}ms`,
        );
        await sleep(wait);
      }
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new LlmError(`${opts.phase}: ${opts.unit} exhausted ${maxAttempts} attempts: ${String(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
