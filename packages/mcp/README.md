# `@bb/mcp` — context

## Tier

Domain. Imports `@bb/graph-db` (the `searchGraph` facade) and
`@bb/graph-core` (read-side types like `ScoredHit`,
`KnowledgeListRow`), `@bb/config` (`getPlumblineHome`), `@bb/types` for
shared shapes, and `zod` + `@modelcontextprotocol/sdk`. Does not import
from sibling domain packages, from binaries (`@bb/server`, `@bb/cli`),
or from any concrete graph provider (`@bb/neo4j` / `@bb/ladybug`) —
the provider is resolved at runtime through `searchGraph`.

## Responsibility

Owns the public MCP retrieval surface. Builds a single `McpServer`
instance from `@modelcontextprotocol/sdk`, mounts both Streamable HTTP
(`/mcp`) and legacy SSE (`/sse` + `/sse/messages`) transports onto an
externally-supplied Express application, registers four retrieval
tools and a skill-distribution resource channel.

The package owns:

- A single shared `McpServer` instance (lazy, idempotent build) named
  `plumbline-public`, version pulled from this `package.json`.
- Per-session `StreamableHTTPServerTransport` instances keyed by
  `mcp-session-id`. New sessions are created on initialize requests;
  existing sessions are looked up by header.
- Per-session `SSEServerTransport` instances keyed by the SDK-generated
  `sessionId`, exposed via a query param on `/sse/messages`.
- Four registered tools — `list_knowledge`, `smart_search`,
  `keyword_lookup`, `retrieve_file` — registered via the modern
  `server.registerTool(...)` config-object API. `list_knowledge` is
  registered first so it sits at the top of `tools/list` output and
  the LLM gravitates toward calling it before anything else.
- Two resources — `plumbline://skills/index` (JSON listing of bundled
  skills) and `plumbline://skills/{skillName}/{filename}` (individual
  markdown file content). Backed by the bundled `skills/` directory
  beside `package.json`.
- Graceful shutdown — `closeAllMcpSessions()` closes every active
  transport so `@bb/server`'s shutdown hook can complete cleanly.

The package does **not** own:

- Auth gating. MCP is unauthenticated in the OSS engine —
  single-tenant, localhost-only. See [docs/mcp.md](../../docs/mcp.md)
  "Transport and mounting".
- Document-store or LLM access. The retrieval tools are pure
  graph-and-disk reads.
- HTTP body parsing — relies on `@bb/server`'s top-level `express.json`.

## Public exports

```ts
function mountMcp(app: express.Application): void;
function closeAllMcpSessions(): Promise<void>;
```

`mountMcp` is idempotent — calling it twice on the same app is a
no-op.

## Routes mounted

```
POST   /mcp                         Streamable HTTP — initialize / requests / responses
GET    /mcp                         Streamable HTTP — server-to-client streaming
DELETE /mcp                         Streamable HTTP — session terminate

GET    /sse                         SSE — open a long-lived stream
POST   /sse/messages?sessionId=…    SSE — client-to-server messages
```

## Tools

| Name             | Inputs                                                                                                            | Output shape                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_knowledge` | `page?`                                                                                                           | `{knowledgeBases: [{knowledgeId, repoName, sourceKind, sourceUrl, branch, state, fileCount, createdAt, updatedAt}], totalItems, pagination}` |
| `smart_search`   | `query`, `knowledgeId?`, `knowledgeIds?`, `path?`, `exclude?`, `page?`, `pageSize?`                               | `{query, channels_used, total_matches, repos_matched[], top_results[], clusters[], concept_clusters?[]}`                                     |
| `keyword_lookup` | `term`, `match? (default keyword)`, `knowledgeId?`, `knowledgeIds?`, `keywordLimit?`, `filesPerKeyword?`, `page?` | `{query, match, cross_repo, total_matched, matched[], pagination}`                                                                           |
| `retrieve_file`  | `operation? (default content)`, `knowledgeId`, op-specific params                                                 | `{operation, …}` — varies by op                                                                                                              |

All four tools issue their graph reads through `searchGraph`
(`IGraphSearchRepository`). MCP never builds Cypher strings or
provider-specific value types — each backend (Neo4j today, Ladybug when
ready) owns its own query dialect.

`list_knowledge` is the session-start tool. Calls
`searchGraph.listKnowledgeBases()` which the active provider implements
against its knowledge / file node store, ordered by `updatedAt` desc.
Pagination packs rows into pages until a ~5000-token char budget is
hit. The `state` field flows `CREATED → QUEUED → INGESTED → PROCESSING
→ PROCESSED | FAILED`; the LLM should treat any state other than
`PROCESSED` as not-yet-queryable.

`smart_search` dispatches the eight channels (purpose, businessContext,
paths, keywords, classes, functions, importsInternal, importsExternal)
in parallel via `searchGraph.runSmartSearchChannel(channel, params)`.
`smartSearchFusion.ts` normalizes per-channel scores against the
channel max, applies fixed weights (see `CHANNEL_WEIGHTS`), dedupes by
`(knowledgeId, path)`, hydrates `repoName` via
`searchGraph.fetchRepoNames(ids)`, and computes folder clusters in JS
(top-two-segments grouping — no `FolderNode` dependency).

Both `smart_search` and `keyword_lookup` accept `knowledgeIds?:
string[]` for multi-repo scoping. When provided, it intersects with the
older single-value `knowledgeId?` and the result set is constrained to
files whose `knowledgeId` is in the allowlist. Used by ConceptGraphStrategy
enrichment to query its own in-flight knowledge plus opted-in cross-repo
neighbours.

`smart_search` returns an optional `concept_clusters?: ConceptCluster[]`
field when files in the result set carry `:Concept` attachments of
kinds `role` / `pattern` / `domain` (ConceptGraphStrategy hypergraph).
Each cluster lists `{slug, kind, name, file_count, sample_files[]}`;
the field is omitted entirely when no qualifying concepts exist (e.g.
all knowledges in the result were indexed by `flat-folder`).

`keyword_lookup` is a reverse lookup. Calls
`searchGraph.keywordLookup({match, term, ...})` — the provider chooses
fulltext vs. substring matching based on `match` (keyword / class /
function use the appropriate fulltext index; module uses a plain
`CONTAINS` over `Module.name`). Pagination packs matched-entity entries
into pages until a ~5000-token char budget is hit.

`retrieve_file` has three operations:

- `metadata` — `relativePaths[]` (≤ 10) → `searchGraph.fetchFileMetadata`
  which returns per-file `{purpose, summary, classes[], functions[],
imports[], keywords[], language, sizeBytes}` from the active provider.
- `content` — single `relativePath` + optional `fromLine`/`toLine` /
  `search` / `contextLines` / `maxTokens`. Resolves the active commit's
  clone via `repoFs.ts` (one `KnowledgeDoc` lookup per call to derive
  `(orgId, owner, repo, commitId)`), reads from
  `~/.plumbline/orgs/<orgId>/github/<knowledgeId>/<owner>/<repo>/<commit>/repository/{relativePath}`,
  slices in process, prepends line numbers, trims to the token char
  budget. Local knowledges read straight from `source.sourcePath`.
- `bulk_search` — `paths[]` (≤ 50) + required `search` + optional
  `contextLines` / `matchOnly`. Parallel disk scan; returns matched +
  noMatch + errored.

## Resources

`plumbline://skills/index` — JSON listing of bundled skills, generated
on each request from disk. Each entry: `{name, description (parsed
from SKILL.md frontmatter), install_path, files: [{filename, bytes}]}`.

`plumbline://skills/{skillName}/{filename}` — markdown content for a
single skill file. URI templating handled by the SDK.

The bundled directory is `<package>/skills/` (relative to `package.json`).
Resolution uses `import.meta.url` so the layout works in dev (`bun run`)
and from a built output. `skills/plumbline/SKILL.md` and
`skills/plumbline/plumbline-code-search.md` are the two files shipped in v1.

## Data ownership

- Transient: per-session transport objects in two module-scoped `Map`s
  (one per transport flavour). Cleared on `transport.onclose` /
  `res.on("close")`, or by `closeAllMcpSessions`.
- Read-only access to the graph through `@bb/graph-db`'s `searchGraph`
  facade (which proxies to the active `IGraphSearchRepository`) and
  to the local clone directory through `@bb/config`'s
  `getPlumblineHome()`. No writes.

## Invariants

1. **One `McpServer` instance per process.** `mountMcp` uses a
   module-level guard so repeat calls do not rebuild.
2. **No `process.env` reads.** Tunable thresholds live as module-level
   constants for v1; promote to `@bb/config` when configurability is
   actually needed.
3. **No auth.** v1 ships unauthenticated. A future paid-tier could
   wrap the same `mountMcp` in a token check at the binary layer.
4. **Transports are owned, not leaked.** Every transport created here
   either lives in the per-flavour `Map` or has been closed.
   `closeAllMcpSessions` drains both maps.
5. **Disk I/O is path-traversal safe.** `repoFs.ts` rejects absolute
   paths, `..` components, and any resolved target outside
   `<plumblineHome>/repos/{knowledgeId}/`.
6. **No non-null assertions, no `any`, no dynamic `import()`.** Repo-wide
   strict-types rules apply — see CLAUDE.md.
7. **Tool input types use `field?: T | undefined`.** The Zod-inferred
   shapes the SDK emits use `T | undefined` for optional fields; under
   `exactOptionalPropertyTypes` we must echo that on our own input
   interfaces.

## External dependencies

- `@modelcontextprotocol/sdk@^1.23.0` — official TypeScript SDK
- `zod@^4.3.6` — input schemas for `registerTool`
- `@types/express` (dev) — types only; no express runtime dep
- `@bb/graph-db` (workspace) — `searchGraph` facade for all read queries
- `@bb/graph-core` (workspace) — read-side row/input types
- `@bb/config` (workspace) — `getPlumblineHome` for the clone directory
- `@bb/types` (workspace) — shared shapes (no direct usage in v1, kept
  for upcoming tier integrations)

## How to extend

Adding a tool:

1. Create `src/<toolName>Tool.ts` exporting
   `register<ToolName>Tool(server: McpServer): void`. Use
   `server.registerTool(name, { description, inputSchema }, cb)` (the
   non-deprecated overload).
2. Declare the input interface with `field?: T | undefined` for every
   optional Zod field.
3. Call the new register fn from `buildMcpServer()` in `src/server.ts`.
4. Wire any new infra dep into `package.json`.
5. Update _Tools_ + _Files_ in this context and in `src/README.md`.

Adding a resource:

1. Create `src/resources<Name>.ts` exporting
   `register<Name>Resources(server: McpServer): void`.
2. Same wiring as tools — call from inside `buildMcpServer()`.
