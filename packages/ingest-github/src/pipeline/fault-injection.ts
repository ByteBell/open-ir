// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  TEST-ONLY FAULT INJECTION — REMOVE BEFORE MERGE.
//
// One-shot, env-gated transient LLM failure used to exercise the
// HALTED → retry → PROCESSED loop end-to-end without a real provider outage.
//
//   Enable:  set env  PLUMBLINE_FORCE_HALT_ONCE=1  on the worker process
//            (knowledge-server), then ingest a repo.
//
// Behaviour: the FIRST job attempt for each knowledgeId throws a *retryable*
// LlmError (HTTP 503 → category `llm_unreachable`), so the pipeline writes
// HALTED and the queue schedules a retry (~5s). The SECOND attempt is allowed to
// proceed normally → PROCESSED. The "already injected" set is in-memory and
// per-process, so it resets on restart and never affects a fresh deploy.
//
// The flag is read through `@bb/config`'s `isForceHaltOnceEnabled()` (the
// sanctioned env boundary), not via `process.env` here — see the Rule of Env
// Vars. Delete this file and its call site in `run.ts` (and the config helper)
// once the HALTED flow has been verified.
// ─────────────────────────────────────────────────────────────────────────────
import { isForceHaltOnceEnabled } from "@bb/config";
import { LlmError } from "@bb/errors";
import { logger } from "@bb/logger";

const alreadyInjected = new Set<string>();

/**
 * Throws a one-shot retryable LlmError on the first attempt for `knowledgeId`
 * when `PLUMBLINE_FORCE_HALT_ONCE=1`. No-op otherwise (flag off, or this
 * knowledge already had its forced failure on a prior attempt).
 */
export function maybeInjectOneShotHalt(knowledgeId: string): void {
  if (!isForceHaltOnceEnabled()) {
    return;
  }
  if (alreadyInjected.has(knowledgeId)) {
    logger.warn(`[FAULT-INJECT] ${knowledgeId}: retry attempt — letting it proceed (expect recovery → PROCESSED)`);
    return;
  }
  alreadyInjected.add(knowledgeId);
  logger.warn(`[FAULT-INJECT] ${knowledgeId}: forcing one-shot transient LLM failure (expect HALTED → retry)`);
  throw new LlmError("forced transient LLM failure (PLUMBLINE_FORCE_HALT_ONCE test hook)", undefined, { status: 503 });
}
