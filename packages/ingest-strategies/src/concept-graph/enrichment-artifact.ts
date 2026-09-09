import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MetaPaths } from "@bb/ingest-core";
import type { PerFileEnrichment } from "./enrichment-schema.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Disk audit trail for the ConceptGraphStrategy per-file enrichment phase.
// Layout: `<metaOutputRoot>/enrichment/<file-slug>.json`. One file per
// successfully enriched source file. The graph is the canonical store; disk
// is the "why was this concept created" audit trail required by the LLM
// usage rule. `KnowledgeDoc.completedFiles[]` is the resume cursor —
// disk artifacts are write-only from the strategy's perspective, written on
// success and never re-read by the strategy (a manual diff against graph
// state is possible if needed).
//
// `metaOutputRoot` is already commit-scoped
// (`orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/meta-output/`),
// so re-indexing at a new commit naturally lands in a fresh tree without any
// commit-id segment inside the enrichment subdir.
// ─────────────────────────────────────────────────────────────────────────────

const FILE_SLUG_MAX_LEN = 200;

export interface EnrichmentArtifactLayout {
  baseDir: string;
  pathForFile(relativePath: string): string;
}

export function enrichmentArtifactLayout(metaPaths: MetaPaths): EnrichmentArtifactLayout {
  const baseDir = path.join(metaPaths.metaOutputRoot, "enrichment");
  return {
    baseDir,
    pathForFile(relativePath: string): string {
      return path.join(baseDir, `${fileSlugFromRelativePath(relativePath)}.json`);
    },
  };
}

/**
 * Deterministic slug for a relative path, suitable as a filename. We replace
 * path separators with `__` so the resulting filename is unambiguous when
 * scanning a flat directory. Long paths are truncated and suffixed with a
 * short hash to keep the filename uniqueness intact.
 */
export function fileSlugFromRelativePath(relativePath: string): string {
  const flat = relativePath
    .replace(/^[/\\]+/u, "")
    .replace(/[/\\]/gu, "__")
    .replace(/[^a-zA-Z0-9._-]/gu, "_");
  if (flat.length <= FILE_SLUG_MAX_LEN) {
    return flat;
  }
  // Truncate but append a stable short hash so two long paths don't collide.
  const head = flat.slice(0, FILE_SLUG_MAX_LEN - 9);
  const hash = simpleHash(flat).toString(16).padStart(8, "0").slice(0, 8);
  return `${head}-${hash}`;
}

function simpleHash(input: string): number {
  // FNV-1a 32-bit. Sufficient for filename disambiguation; never used for
  // any cryptographic / security purpose.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export interface EnrichmentArtifactPayload {
  relativePath: string;
  knowledgeId: string;
  commitId: string;
  enrichmentRunId: string;
  enrichment: PerFileEnrichment;
  llmUsage: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
  iterations: number;
  toolCallCount: number;
  writtenAt: string;
}

export async function writeEnrichmentArtifact(
  layout: EnrichmentArtifactLayout,
  payload: EnrichmentArtifactPayload,
): Promise<void> {
  await mkdir(layout.baseDir, { recursive: true });
  const target = layout.pathForFile(payload.relativePath);
  await writeFile(target, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * Cheap disk-level resume guard: true if a successful artifact already
 * exists for this file at the commit-scoped layout. Called on every retry
 * before scheduling the LLM call, so a single fs stat per file is the
 * difference between "re-burn the LLM" and "skip".
 */
export async function enrichmentArtifactExists(
  layout: EnrichmentArtifactLayout,
  relativePath: string,
): Promise<boolean> {
  try {
    const s = await stat(layout.pathForFile(relativePath));
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
