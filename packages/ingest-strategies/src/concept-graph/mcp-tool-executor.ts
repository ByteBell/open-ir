import {
  runSmartSearch,
  runKeywordLookup,
  fetchMetadata,
  readFileRange,
  type SmartSearchInput,
  type KeywordLookupInput,
} from "@bb/mcp";
import type { ToolDefinition } from "@bb/llm";

// ─────────────────────────────────────────────────────────────────────────────
// Bridges the LLM tool-use loop to the same MCP tool runners the public
// transport calls. Stays in-process: no HTTP loopback, no SSE, no SDK
// transport — just direct function calls to the @bb/mcp runners. Justified
// because workers run inside `plumbline-server`'s process (see CLAUDE.md
// "Rule of Queue Safety"). The strategy code is the only in-process consumer
// of these runners today; if a second one appears, lift this module to a
// shared location.
//
// Scope discipline: every call defaults `knowledgeIds` to a single-element
// list containing the currently-enriching knowledge id. Cross-repo searches
// are an explicit opt-in (the LLM passes a different `knowledgeIds` array).
// The executor never strips an explicit `knowledgeIds` the LLM provides —
// it only fills the default when absent.
// ─────────────────────────────────────────────────────────────────────────────

export interface McpToolExecutorOptions {
  /** The knowledge currently being enriched. Used as the default `knowledgeIds` scope. */
  knowledgeId: string;
}

/**
 * Returns the catalog of tool definitions to pass to `askLLMWithTools`. The
 * JSON Schema parameters here are hand-curated for the enrichment use case
 * (a strict subset of what the public MCP tools accept) — we don't expose
 * pagination knobs the LLM doesn't need, and we strip exclusion controls.
 */
export function buildEnrichmentToolCatalog(): ToolDefinition[] {
  return [
    {
      name: "smart_search",
      description:
        "Search the indexed knowledge graph for files matching a term. Returns top-K files plus folder and concept clusters. Default scope is the current knowledge; pass `knowledgeIds` to search across repos.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term." },
          knowledgeIds: {
            type: "array",
            items: { type: "string" },
            description: "Knowledge IDs to search. Omit to default to the current knowledge.",
          },
          path: { type: "string", description: "Optional path prefix filter (e.g. 'src/auth')." },
          pageSize: { type: "integer", minimum: 10, maximum: 100 },
        },
        required: ["query"],
      },
    },
    {
      name: "keyword_lookup",
      description:
        "Reverse lookup: given a named entity (keyword, class, function, or module), list every file that links to it.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "Entity name (case-insensitive contains)." },
          match: {
            type: "string",
            enum: ["keyword", "class", "function", "module"],
            description: "Which entity kind to match. Default: keyword.",
          },
          knowledgeIds: {
            type: "array",
            items: { type: "string" },
            description: "Knowledge IDs to search. Omit to default to the current knowledge.",
          },
        },
        required: ["term"],
      },
    },
    {
      name: "retrieve_file_metadata",
      description: "Fetch full metadata (purpose, summary, classes, functions, imports) for up to 10 files.",
      parameters: {
        type: "object",
        properties: {
          knowledgeId: { type: "string", description: "Knowledge ID. Defaults to the current knowledge." },
          relativePaths: { type: "array", items: { type: "string" }, maxItems: 10 },
        },
        required: ["relativePaths"],
      },
    },
    {
      name: "retrieve_file_content",
      description: "Read a line range or search within a single file. Returns numbered lines.",
      parameters: {
        type: "object",
        properties: {
          knowledgeId: { type: "string", description: "Knowledge ID. Defaults to the current knowledge." },
          relativePath: { type: "string" },
          fromLine: { type: "integer", minimum: 1 },
          toLine: { type: "integer", minimum: 1 },
          search: { type: "string" },
          contextLines: { type: "integer", minimum: 0, maximum: 10 },
          maxTokens: { type: "integer", minimum: 1000, maximum: 50000 },
        },
        required: ["relativePath"],
      },
    },
  ];
}

/**
 * Returns the `executeTool` callback the loop invokes for each tool the
 * model selects. Defaults `knowledgeIds` (or single-value `knowledgeId`) to
 * the current knowledge when the model omits the field.
 */
export function buildEnrichmentToolExecutor(
  opts: McpToolExecutorOptions,
): (name: string, input: Record<string, unknown>) => Promise<unknown> {
  return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "smart_search":
        return runSmartSearch(coerceSmartSearchInput(input, opts.knowledgeId));
      case "keyword_lookup":
        return runKeywordLookup(coerceKeywordLookupInput(input, opts.knowledgeId));
      case "retrieve_file_metadata":
        return fetchMetadata(coerceKnowledgeId(input, opts.knowledgeId), coerceStringArray(input["relativePaths"]));
      case "retrieve_file_content": {
        const contentOpts: Parameters<typeof readFileRange>[0] = {
          knowledgeId: coerceKnowledgeId(input, opts.knowledgeId),
          relativePath: coerceString(input["relativePath"], "relativePath"),
        };
        if (typeof input["fromLine"] === "number") {
          contentOpts.fromLine = input["fromLine"];
        }
        if (typeof input["toLine"] === "number") {
          contentOpts.toLine = input["toLine"];
        }
        if (typeof input["search"] === "string") {
          contentOpts.search = input["search"];
        }
        if (typeof input["contextLines"] === "number") {
          contentOpts.contextLines = input["contextLines"];
        }
        if (typeof input["maxTokens"] === "number") {
          contentOpts.maxTokens = input["maxTokens"];
        }
        return readFileRange(contentOpts);
      }
      default:
        throw new Error(`enrichment executor: unknown tool "${name}"`);
    }
  };
}

function coerceSmartSearchInput(input: Record<string, unknown>, defaultKnowledgeId: string): SmartSearchInput {
  const out: SmartSearchInput = { query: coerceString(input["query"], "query") };
  if (Array.isArray(input["knowledgeIds"]) && input["knowledgeIds"].length > 0) {
    out.knowledgeIds = coerceStringArray(input["knowledgeIds"]);
  } else {
    out.knowledgeIds = [defaultKnowledgeId];
  }
  if (typeof input["path"] === "string") {
    out.path = input["path"];
  }
  if (typeof input["pageSize"] === "number") {
    out.pageSize = input["pageSize"];
  }
  return out;
}

function coerceKeywordLookupInput(input: Record<string, unknown>, defaultKnowledgeId: string): KeywordLookupInput {
  const out: KeywordLookupInput = { term: coerceString(input["term"], "term") };
  const match = input["match"];
  if (match === "keyword" || match === "class" || match === "function" || match === "module") {
    out.match = match;
  }
  if (Array.isArray(input["knowledgeIds"]) && input["knowledgeIds"].length > 0) {
    out.knowledgeIds = coerceStringArray(input["knowledgeIds"]);
  } else {
    out.knowledgeIds = [defaultKnowledgeId];
  }
  return out;
}

function coerceKnowledgeId(input: Record<string, unknown>, fallback: string): string {
  return typeof input["knowledgeId"] === "string" && input["knowledgeId"].length > 0 ? input["knowledgeId"] : fallback;
}

function coerceString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`enrichment executor: required string "${name}" missing`);
  }
  return value;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("enrichment executor: expected array of strings");
  }
  return value.map((v) => {
    if (typeof v !== "string") {
      throw new Error("enrichment executor: array element is not a string");
    }
    return v;
  });
}
