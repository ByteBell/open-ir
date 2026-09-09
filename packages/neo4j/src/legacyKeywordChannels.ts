import type { FileAnalysis } from "@bb/db-core";

// Maps a FileAnalysis into the 14 channels the legacy reader expects to find
// materialized as (:OrgKeyword {keyword, type, org_id, content_type:'code'})
// nodes linked by [:APPEARS_IN_FILE {frequency, org_id}]->(:FileNode). The
// chat-mcp search tools (smart_search / graph_search / keyword_lookup /
// blast_radius) all key off these OrgKeyword types — the new pipeline's
// :Keyword/:Class/:Function/:Module nodes (reversed direction, different
// label) are invisible to them.

export interface LegacyKeywordChannel {
  readonly values: readonly string[];
  readonly type: string;
}

export function legacyKeywordChannels(analysis: FileAnalysis): readonly LegacyKeywordChannel[] {
  const dataFlow = analysis.dataFlowDirection ?? "";
  return [
    { values: lowercaseAll(analysis.keywords ?? []), type: "HAS_KEYWORD" },
    { values: analysis.classes ?? [], type: "HAS_CLASS" },
    { values: analysis.functions ?? [], type: "HAS_FUNCTION" },
    { values: analysis.importsInternal ?? [], type: "HAS_IMPORT_INTERNAL" },
    { values: analysis.importsExternal ?? [], type: "HAS_IMPORT_EXTERNAL" },
    { values: analysis.ontologyConcepts ?? [], type: "HAS_ONTOLOGY_CONCEPT" },
    { values: analysis.businessEntities ?? [], type: "HAS_BUSINESS_ENTITY" },
    { values: analysis.systemCapabilities ?? [], type: "HAS_SYSTEM_CAPABILITY" },
    { values: analysis.sideEffects ?? [], type: "HAS_SIDE_EFFECT" },
    { values: analysis.configDependencies ?? [], type: "HAS_CONFIG_DEPENDENCY" },
    { values: analysis.integrationSurface ?? [], type: "HAS_INTEGRATION_SURFACE" },
    { values: analysis.contractsProvided ?? [], type: "PROVIDES_CONTRACT" },
    { values: analysis.contractsConsumed ?? [], type: "CONSUMES_CONTRACT" },
    { values: dataFlow.length > 0 ? [dataFlow] : [], type: "HAS_DATA_FLOW_DIRECTION" },
  ];
}

/**
 * Flattened param shape passed to the OrgKeyword materialization Cypher.
 * Each entry becomes one MERGE on :OrgKeyword + one MERGE on :APPEARS_IN_FILE.
 */
export interface LegacyOrgKeywordEdge {
  readonly knowledgeId: string;
  readonly relativePath: string;
  readonly orgId: string;
  readonly keyword: string;
  readonly type: string;
}

/**
 * Expand a FileAnalysis into one edge per (channel.value, channel.type) pair
 * tagged with the file the edge originates from. Empty values are dropped
 * (the Cypher side also filters but JS-side is cheaper).
 */
export function expandLegacyOrgKeywordEdges(
  inputs: ReadonlyArray<{
    readonly knowledgeId: string;
    readonly relativePath: string;
    readonly orgId: string;
    readonly analysis: FileAnalysis;
  }>,
): readonly LegacyOrgKeywordEdge[] {
  const out: LegacyOrgKeywordEdge[] = [];
  for (const input of inputs) {
    for (const channel of legacyKeywordChannels(input.analysis)) {
      for (const raw of channel.values) {
        const value = raw.trim();
        if (value.length === 0) {
          continue;
        }
        out.push({
          knowledgeId: input.knowledgeId,
          relativePath: input.relativePath,
          orgId: input.orgId,
          keyword: value,
          type: channel.type,
        });
      }
    }
  }
  return out;
}

function lowercaseAll(values: readonly string[]): string[] {
  return values.map((v) => v.toLowerCase());
}
