// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import type { EnrichmentFailure, KnowledgeDoc } from "@bb/types";
import { EnrichmentState } from "@bb/types";
import { KnowledgeNotFoundError } from "@bb/errors";
import { getSqliteDb } from "./client.ts";

// ─────────────────────────────────────────────────────────────────────────────
// SQLite enrichment ledger for ConceptGraphStrategy. State lives on the
// existing knowledge row's JSON document — no new table. `status.state` itself
// stays PROCESSING throughout enrichment; this ledger tracks per-file progress
// so a queue retry can resume by skipping `completedFiles`.
//
// `bun:sqlite` is synchronous, so a read-modify-write with no `await` between
// the SELECT and the UPDATE cannot interleave with a concurrent enrichment
// worker on the JS event loop. Every mutator below keeps that property.
//
// All operations throw `KnowledgeNotFoundError` if the document is missing.
// ─────────────────────────────────────────────────────────────────────────────

/** Loads the knowledge document, throwing when the row is absent. */
function loadDoc(knowledgeId: string): KnowledgeDoc {
  const row = getSqliteDb().query("SELECT value FROM knowledge WHERE key = ?").get(knowledgeId) as {
    value: string;
  } | null;
  if (!row) {
    throw new KnowledgeNotFoundError(knowledgeId);
  }
  return JSON.parse(row.value) as KnowledgeDoc;
}

/** Writes the document back, stamping `updatedAt`. */
function saveDoc(knowledgeId: string, doc: KnowledgeDoc): void {
  doc.updatedAt = new Date();
  getSqliteDb().run("UPDATE knowledge SET value = ? WHERE key = ?", [JSON.stringify(doc), knowledgeId]);
}

/**
 * Begin or resume an enrichment attempt. Stamps a new `enrichmentRunId`,
 * clears `enrichmentFailures` (failed files should be re-evaluated on the
 * retry), transitions to `Running`. `completedFiles` is preserved so a
 * queue retry can skip work that already finished — the disk artifact tree
 * at `meta-output/enrichment/<slug>.json` is the canonical source of truth,
 * and `completedFiles` mirrors that. A clean re-enrichment requires an
 * explicit reset, not a retry.
 */
export async function startEnrichmentRun(knowledgeId: string, runId: string): Promise<void> {
  const doc = loadDoc(knowledgeId);
  doc.enrichmentRunId = runId;
  doc.enrichmentState = EnrichmentState.Running;
  doc.enrichmentFailures = [];
  if (!Array.isArray(doc.completedFiles)) {
    doc.completedFiles = [];
  }
  saveDoc(knowledgeId, doc);
}

/**
 * Returns the list of files already enriched in the current/last attempt.
 * Used by the strategy to pre-filter the work queue on retry. Empty array
 * if the knowledge has no recorded enrichment runs.
 */
export async function getCompletedEnrichmentFiles(knowledgeId: string): Promise<string[]> {
  const doc = loadDoc(knowledgeId);
  return Array.isArray(doc.completedFiles) ? doc.completedFiles : [];
}

/**
 * Records that `filePath` has been successfully enriched. Idempotent: the
 * path is added set-wise so a re-run of the same file does not duplicate it.
 */
export async function markFileEnriched(knowledgeId: string, filePath: string): Promise<void> {
  const doc = loadDoc(knowledgeId);
  const completed = Array.isArray(doc.completedFiles) ? doc.completedFiles : [];
  if (completed.includes(filePath)) {
    return;
  }
  completed.push(filePath);
  doc.completedFiles = completed;
  saveDoc(knowledgeId, doc);
}

/**
 * Records or updates a per-file enrichment failure. The array is keyed by
 * `filePath` (one entry per file); subsequent failures for the same file
 * replace the prior entry rather than accumulating. Diagnostic, not
 * load-bearing — the strategy decides whether the knowledge fails overall.
 */
export async function recordEnrichmentFailure(knowledgeId: string, failure: EnrichmentFailure): Promise<void> {
  const doc = loadDoc(knowledgeId);
  const failures = Array.isArray(doc.enrichmentFailures) ? doc.enrichmentFailures : [];
  doc.enrichmentFailures = [...failures.filter((f) => f.filePath !== failure.filePath), failure];
  saveDoc(knowledgeId, doc);
}

/** Transitions the ledger to `Completed`. Caller is responsible for then transitioning the parent `KnowledgeState`. */
export async function completeEnrichmentRun(knowledgeId: string): Promise<void> {
  const doc = loadDoc(knowledgeId);
  doc.enrichmentState = EnrichmentState.Completed;
  saveDoc(knowledgeId, doc);
}

/**
 * Transitions the ledger to `Failed`. Knowledge can be retried by calling
 * `startEnrichmentRun` again with a fresh run id.
 */
export async function failEnrichmentRun(knowledgeId: string): Promise<void> {
  const doc = loadDoc(knowledgeId);
  doc.enrichmentState = EnrichmentState.Failed;
  saveDoc(knowledgeId, doc);
}
