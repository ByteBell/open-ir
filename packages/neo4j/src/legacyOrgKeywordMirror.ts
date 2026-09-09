import { _runCypher, type CypherStep } from "./client.ts";
import { expandLegacyOrgKeywordEdges, type LegacyOrgKeywordEdge } from "./legacyKeywordChannels.ts";
import type { FileAnalysis } from "@bb/db-core";

// :OrgKeyword + [:APPEARS_IN_FILE]->:FileNode materialization for the
// legacy snake_case search graph used by chat-mcp smart_search /
// graph_search / keyword_lookup / blast_radius. One :APPEARS_IN_FILE
// edge per (keyword,type) value per file; frequency is always 1 per edge
// (the legacy model — aggregate counters live on the OrgKeyword node and
// are recomputed by recomputeOrgKeywordCountersForKnowledge).

const CLEAR_ORGKEYWORD_EDGES_FOR_FILE = `
MATCH (fn:FileNode {knowledge_id: $knowledgeId, relative_path: $relativePath})
      <-[r:APPEARS_IN_FILE]-(:OrgKeyword)
DELETE r
`;

const BATCH_CLEAR_ORGKEYWORD_EDGES = `
UNWIND $files AS f
MATCH (fn:FileNode {knowledge_id: f.knowledgeId, relative_path: f.relativePath})
      <-[r:APPEARS_IN_FILE]-(:OrgKeyword)
DELETE r
`;

const MERGE_ORGKEYWORDS = `
UNWIND $edges AS edge
MATCH (fn:FileNode {knowledge_id: edge.knowledgeId, relative_path: edge.relativePath})
WITH fn, edge
MERGE (kw:OrgKeyword {keyword: edge.keyword, type: edge.type, org_id: edge.orgId})
ON CREATE SET kw.created_at = $updatedAt,
              kw.content_type = 'code',
              kw.total_frequency = 0,
              kw.file_count = 0
MERGE (kw)-[r:APPEARS_IN_FILE]->(fn)
SET r.frequency = 1,
    r.org_id = edge.orgId,
    r.updated_at = $updatedAt
`;

const RECOMPUTE_COUNTERS_FOR_KNOWLEDGE = `
MATCH (kw:OrgKeyword {org_id: $orgId})-[:APPEARS_IN_FILE]->(:FileNode {knowledge_id: $knowledgeId})
WITH DISTINCT kw
OPTIONAL MATCH (kw)-[r:APPEARS_IN_FILE]->(fn:FileNode)
WITH kw, sum(coalesce(r.frequency, 0)) AS tf, count(DISTINCT fn) AS fc
SET kw.total_frequency = tf,
    kw.file_count = fc
`;

const RECOMPUTE_COUNTERS_FOR_ORG = `
MATCH (kw:OrgKeyword {org_id: $orgId})
OPTIONAL MATCH (kw)-[r:APPEARS_IN_FILE]->(fn:FileNode)
WITH kw, sum(coalesce(r.frequency, 0)) AS tf, count(DISTINCT fn) AS fc
SET kw.total_frequency = tf,
    kw.file_count = fc
`;

export interface MirrorFileInput {
  readonly knowledgeId: string;
  readonly relativePath: string;
  readonly orgId: string;
  readonly analysis: FileAnalysis;
}

/** Clear + remerge :OrgKeyword edges for a single file. */
export async function mirrorFileOrgKeywords(input: MirrorFileInput): Promise<void> {
  const edges = expandLegacyOrgKeywordEdges([input]);
  await _runCypher(CLEAR_ORGKEYWORD_EDGES_FOR_FILE, {
    knowledgeId: input.knowledgeId,
    relativePath: input.relativePath,
  });
  if (edges.length === 0) {
    return;
  }
  await _runCypher(MERGE_ORGKEYWORDS, { edges, updatedAt: new Date().toISOString() });
}

/**
 * Build the Cypher steps that mirror :OrgKeyword for a batch of files.
 * Returns steps suitable for appending to the caller's _runInTransaction list,
 * so the mirror lands in the same transaction as the primary FileNode upsert.
 */
export function buildOrgKeywordMirrorSteps(inputs: ReadonlyArray<MirrorFileInput>, updatedAt: string): CypherStep[] {
  if (inputs.length === 0) {
    return [];
  }
  const fileKeys = inputs.map((i) => ({ knowledgeId: i.knowledgeId, relativePath: i.relativePath }));
  const edges: readonly LegacyOrgKeywordEdge[] = expandLegacyOrgKeywordEdges(inputs);
  const steps: CypherStep[] = [{ query: BATCH_CLEAR_ORGKEYWORD_EDGES, params: { files: fileKeys } }];
  if (edges.length > 0) {
    steps.push({ query: MERGE_ORGKEYWORDS, params: { edges, updatedAt } });
  }
  return steps;
}

/**
 * Recompute :OrgKeyword aggregate counters (total_frequency, file_count) for
 * every keyword that touches a file in `knowledgeId`. Run once at the end of
 * an ingestion strategy invocation so per-edge frequency=1 writes don't
 * leave the counters stale.
 */
export async function recomputeOrgKeywordCountersForKnowledge(orgId: string, knowledgeId: string): Promise<void> {
  await _runCypher(RECOMPUTE_COUNTERS_FOR_KNOWLEDGE, { orgId, knowledgeId });
}

/** Full org-wide recount — slower; use only for one-off backfills. */
export async function recomputeOrgKeywordCountersForOrg(orgId: string): Promise<void> {
  await _runCypher(RECOMPUTE_COUNTERS_FOR_ORG, { orgId });
}
