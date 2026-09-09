import { LlmConfigError, LlmError, RepoUnavailableError, UsageLimitExceededError } from "@bb/errors";
import type { KnowledgeFailureCategory } from "@bb/types";
import { describe } from "./stats.ts";

export interface ClassifiedFailure {
  /** Operator-readable single-sentence summary. UI surfaces this directly. */
  reason: string;
  category: KnowledgeFailureCategory;
  /** Raw provider response or structured debug payload. Optional. */
  detail?: string;
}

/**
 * Translates a thrown ingestion error into the structured `(reason, category,
 * detail)` triple persisted on `KnowledgeDoc.failure` and stamped on the SSE
 * FAILED event.
 *
 * For LLM transport errors, the provider's HTTP status drives the category so
 * operators can distinguish "wrong key" (401/403) from "out of credits" (402)
 * from "throttled" (429) from "infra down" (5xx). Each path produces a short
 * sentence; the raw response body lands in `detail` for the disclosure UI.
 */
export function classifyFailure(cause: unknown): ClassifiedFailure {
  if (cause instanceof UsageLimitExceededError) {
    return {
      category: "usage_limit_exceeded",
      reason: "LLM token limit reached. Partial indexing was saved. Upgrade your plan to continue.",
      detail: `phase=${cause.phase} current=${cause.current} max=${cause.max} cumulativeTokens=${
        cause.cumulative.inputTokens + cause.cumulative.outputTokens
      }`,
    };
  }
  if (cause instanceof LlmConfigError) {
    // The hint (carried via `cause.hint`) is the actionable bit — it spells
    // out the exact `plumbline set …` / env-var the operator must populate.
    // The flattened "set the API key" wording masked enrichment-model
    // failures from concept-graph; surfacing the hint makes the two cases
    // distinguishable in logs.
    return {
      category: "llm_config",
      reason: `LLM configuration missing. Run: ${cause.hint}`,
      detail: cause.message,
    };
  }
  if (cause instanceof RepoUnavailableError) {
    return {
      category: "repo_unavailable",
      reason: "Source repository not found or inaccessible (deleted/renamed, or token lacks access).",
      detail: cause.message,
    };
  }
  if (cause instanceof LlmError) {
    return classifyLlmTransport(cause);
  }
  return { category: "internal", reason: describe(cause) };
}

/**
 * Categories that warrant an automatic retry. These are transient — a network
 * blip, provider throttle, or unexpected internal error that may not recur on
 * the next attempt. Everything else (bad/expired key, missing config, billing
 * exhausted, user cancellation, usage cap) is operator-actionable and will
 * fail identically on retry, so those go straight to terminal FAILED with no
 * wasted attempts.
 *
 * Single source of truth for the HALTED-vs-FAILED decision in every pipeline
 * catch block (see `run.ts`, `run-local.ts`, `pull.ts`).
 */
const RETRYABLE_CATEGORIES: ReadonlySet<KnowledgeFailureCategory> = new Set([
  "llm_rate_limit",
  "llm_unreachable",
  "internal",
]);

export function isRetryable(category: KnowledgeFailureCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

function classifyLlmTransport(cause: LlmError): ClassifiedFailure {
  const status = cause.status;
  const detail = cause.detail ?? cause.message;
  if (status === 401 || status === 403) {
    return {
      category: "llm_auth",
      reason: "LLM provider rejected the API key. Update the key and retry.",
      detail,
    };
  }
  if (status === 402) {
    return {
      category: "llm_quota",
      reason: "LLM provider is out of credits or over its spend limit. Top up and retry.",
      detail,
    };
  }
  if (status === 429) {
    return {
      category: "llm_rate_limit",
      reason: "LLM provider rate-limited the request. Wait and retry.",
      detail,
    };
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return {
      category: "llm_unreachable",
      reason: `LLM provider responded with HTTP ${String(status)}. Provider is temporarily unavailable.`,
      detail,
    };
  }
  // Network/timeout (no status) or any other non-OK status.
  return {
    category: "llm_unreachable",
    reason:
      status === undefined
        ? "LLM provider is unreachable (network error or timeout)."
        : `LLM provider responded with HTTP ${String(status)}.`,
    detail,
  };
}
