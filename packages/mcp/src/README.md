# `@bb/mcp/src` — context

Implementation of `@bb/mcp`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

`src/` is flat — no subdirectories. The repo-wide rule against parent
traversal makes nested layouts costly, and every other package in this
workspace keeps `src/` flat.

## Files

### Composition root

- **[index.ts](index.ts)** — public surface. Exports `mountMcp(app)`
  (idempotent registration of the four MCP HTTP routes plus `/sse` and
  `/sse/messages`) and `closeAllMcpSessions()` (drains both transport
  maps before shutdown). Owns the module-level `mounted` guard.
- **[server.ts](server.ts)** — `buildMcpServer()` constructs the single
  `McpServer` instance and invokes the five register functions in order
  (list_knowledge first, then smart_search, keyword_lookup,
  retrieve_file, skill resources). Owns the `SERVER_NAME /
SERVER_VERSION / INSTRUCTIONS` constants.

### Transports

- **[streamableHttpTransport.ts](streamableHttpTransport.ts)** — owns
  the per-session map of `StreamableHTTPServerTransport`. Resolves
  existing sessions by `mcp-session-id` header; lazily constructs new
  ones on POST initialize. `as unknown as Transport` cast at the
  `server.connect(...)` call works around an SDK typing mismatch under
  `exactOptionalPropertyTypes`.
- **[sseTransport.ts](sseTransport.ts)** — legacy SSE pair. GET `/sse`
  opens a fresh transport; POST `/sse/messages?sessionId=…` looks it up
  and forwards the body via `handlePostMessage`. Same Transport-cast
  workaround as the streamable transport.

### Tools

- **[listKnowledgeTool.ts](listKnowledgeTool.ts)** — registers
  `list_knowledge`. Single Cypher over `(:Knowledge)` with an
  `OPTIONAL MATCH (:HAS_FILE)->(:File)` aggregate; one row per indexed
  repo carrying `{knowledgeId, repoName, sourceKind, sourceUrl, branch,
state, fileCount, createdAt, updatedAt}` ordered by
  `Knowledge.updatedAt` desc. Inline char-budget pager (same shape as
  `keywordLookupTool.paginate`). This is the session-start tool —
  registered first in `buildMcpServer()` so it appears at the top of
  `tools/list`.
- **[smartSearchTool.ts](smartSearchTool.ts)** — registers
  `smart_search` via the modern `server.registerTool` API. Owns the
  Zod schema, dispatch, parallel-channel orchestration, repo-name
  attachment, pagination, and the JSON char-budget trim loop.
- **[smartSearchChannels.ts](smartSearchChannels.ts)** — eight
  channel runners (purpose, businessContext, paths, keywords, classes,
  functions, importsInternal, importsExternal). Each is one Cypher
  query that returns `{path, knowledgeId, score}`. `purpose` and
  `businessContext` use separate fulltext indexes
  (`idx_file_purpose_summary_ft`, `idx_file_business_context_ft`).
  `importsInternal` and `importsExternal` traverse the matching
  `:HAS_IMPORT_INTERNAL` / `:HAS_IMPORT_EXTERNAL` relationship type
  respectively (kube-package's relative-vs-external split).
  `escapeLucene` and `buildFulltextQuery` helpers shared with
  `keywordLookupTool`. `CHANNEL_RUNNERS` map is exported so the tool
  can iterate channels generically.
- **[smartSearchFusion.ts](smartSearchFusion.ts)** — pure
  in-memory fusion. `fuseHits` normalizes per-channel scores against
  the channel max, applies fixed weights, dedupes, and accumulates
  `matched_channels`. `attachRepoNames` runs a single Cypher to map
  `knowledgeId → Knowledge.repoName`. `clusterByFolder` groups paths
  by their first two path segments and returns clusters with
  `file_count ≥ 2`.
- **[searchExclusions.ts](searchExclusions.ts)** — fixed presets for
  the `exclude` categories (tests, vendor, config, generated, docs,
  build). `EXCLUSION_WHERE` is the Cypher fragment every channel
  embeds via template literal.
- **[keywordLookupTool.ts](keywordLookupTool.ts)** — registers
  `keyword_lookup`. The four `match` modes pick the right Cypher
  template (fulltext + traversal for keyword/class/function; plain
  `CONTAINS` over `Module.name` for module). Returned `name` carries
  the full Class/Function `signature` string when applicable, so the
  embedded line-range hint reaches the caller. Pagination packs
  matched-entity entries until a ~5000-token char budget is hit.
- **[retrieveFileTool.ts](retrieveFileTool.ts)** — registers
  `retrieve_file`. Dispatches to one of three operation modules based
  on the `operation` arg. `formatResult` does the line-numbered text
  rendering for `content` / `content_search` results.
- **[retrieveFileMetadata.ts](retrieveFileMetadata.ts)** — single
  Cypher that joins `File` to its outgoing edges
  (`HAS_KEYWORD`/`HAS_CLASS`/`HAS_FUNCTION`/`HAS_IMPORT_INTERNAL`/`HAS_IMPORT_EXTERNAL`)
  and returns the per-file metadata bundle (purpose, summary,
  businessContext, classes, functions, importsInternal, importsExternal,
  keywords, language, sizeBytes) plus a `notFound[]` list for paths
  that did not resolve.
- **[retrieveFileContent.ts](retrieveFileContent.ts)** — disk read
  via `repoFs.readFileLines`, then either a line-range slice with
  token-budget trim and `nextFromLine`, or a search-within-file pass
  that returns each match plus surrounding `contextLines` of context.
- **[retrieveFileBulk.ts](retrieveFileBulk.ts)** — parallel
  `Promise.all` over the supplied `paths[]`, scanning each file for
  the `search` term. Returns matched / noMatch / errored buckets;
  `matchOnly: true` skips the context-line rendering.
- **[repoFs.ts](repoFs.ts)** — local-clone resolution helpers.
  `resolveCloneDir(knowledgeId)` returns
  `<plumblineHome>/repos/{knowledgeId}`. `resolveFilePath` rejects
  absolute paths, `..` components, and any resolved target outside the
  clone root — a single anti-traversal guard reused by every disk-
  reading helper. `readFileLines` returns the splitted lines;
  `sliceLines` and `prefixWithLineNumbers` support content rendering.

### Resources

- **[resourcesSkills.ts](resourcesSkills.ts)** — registers
  `plumbline://skills/index` and the
  `plumbline://skills/{skillName}/{filename}` template. The bundled
  `<package>/skills/` directory is located via `import.meta.url`.
  `readSkillsIndex` rebuilds the index from disk on each request so
  edits to bundled skill files take effect without a server restart.
  Path resolution rejects any segment containing `/`, `\`, or a
  leading `.` — the same anti-traversal posture as `repoFs`.

## Module dependency graph

```
server.ts                    → @modelcontextprotocol/sdk/server/mcp.js,
                               listKnowledgeTool, smartSearchTool,
                               keywordLookupTool, retrieveFileTool, resourcesSkills

streamableHttpTransport.ts   → node:crypto, express (types only),
                               @modelcontextprotocol/sdk/{server/mcp,server/streamableHttp,types,shared/transport}.js
sseTransport.ts              → express (types only),
                               @modelcontextprotocol/sdk/{server/mcp,server/sse,shared/transport}.js
index.ts                     → express (types only), server.ts,
                               streamableHttpTransport, sseTransport

listKnowledgeTool.ts         → zod, @modelcontextprotocol/sdk/server/mcp.js,
                               @bb/neo4j (runCypher)

searchExclusions.ts          → (no deps)
smartSearchChannels.ts       → @bb/neo4j (runCypher), searchExclusions
smartSearchFusion.ts         → @bb/neo4j (runCypher), smartSearchChannels (types)
smartSearchTool.ts           → zod, @modelcontextprotocol/sdk/server/mcp.js,
                               @bb/neo4j (toNeo4jInt), @bb/logger (getLogger),
                               smartSearchChannels, smartSearchFusion, searchExclusions

keywordLookupTool.ts         → zod, @modelcontextprotocol/sdk/server/mcp.js,
                               @bb/neo4j (runCypher, toNeo4jInt),
                               smartSearchChannels (escape helpers)

retrieveFileTool.ts          → zod, @modelcontextprotocol/sdk/server/mcp.js,
                               retrieveFileMetadata, retrieveFileContent, retrieveFileBulk
retrieveFileMetadata.ts      → @bb/neo4j (runCypher)
retrieveFileContent.ts       → repoFs
retrieveFileBulk.ts          → repoFs
repoFs.ts                    → node:fs/promises, node:path, @bb/config (getPlumblineHome)

resourcesSkills.ts           → node:fs, node:path, node:url,
                               @modelcontextprotocol/sdk/server/mcp.js
```

No cycles. Every read goes through `@bb/neo4j.runCypher` (graph) or
`repoFs` (disk).

## Invariants enforced here

- **`mountMcp` is idempotent.** Module-level `mounted` flag in
  `index.ts`.
- **One `McpServer` per process.** Constructed once inside `mountMcp`,
  captured by closures in route handlers.
- **No express runtime dep.** Only types are imported.
- **Tool input types echo `T | undefined`.** Required to bridge the
  Zod-inferred shapes the SDK emits with our `exactOptionalPropertyTypes`
  consumer side. Every optional field on `*Input` interfaces uses
  `field?: T | undefined`.
- **Disk reads are path-traversal safe.** `repoFs.resolveFilePath`
  is the single gate; `retrieveFileContent` and `retrieveFileBulk`
  must go through it.
- **Errors never leak as unhandled rejections.** Every async route
  handler in `index.ts` is `.catch()`-wrapped; tool handlers return
  thrown errors as MCP error responses (the SDK wraps the throw).
- **Transports are owned, not leaked.** Both transport modules wire
  `onclose` / `res.on("close")` to remove themselves from their map.
  `closeAllMcpSessions` covers shutdown drain.
- **No non-null assertions, no `any`, no dynamic `import()`.**
  Repo-wide strict-types rules apply — see CLAUDE.md.
- **`LIMIT`/`SKIP` params are wrapped with `toNeo4jInt`.** The Neo4j JS
  driver maps bare `number` to Cypher `Float`, which Neo4j 5 rejects in
  `LIMIT`. Every `LIMIT $param` site in this package (currently
  `keywordLookupTool`, `smartSearchTool` → `smartSearchChannels`) binds
  the value through `toNeo4jInt(...)` from `@bb/neo4j`.
- **Per-channel failures in `smart_search` are logged, not swallowed.**
  The Promise.all catch in `smartSearchTool` returns an empty result
  for a failing channel so the other five still surface, and emits a
  `warn`-level log via `@bb/logger` so a regression in one channel is
  visible instead of silently degrading the response.

## Adding a tool

1. Create `src/<toolName>Tool.ts` exporting
   `register<ToolName>Tool(server: McpServer): void`. Use
   `server.registerTool(name, { description, inputSchema }, cb)` (not
   the deprecated `server.tool` overloads).
2. Declare the input interface with `field?: T | undefined` for every
   optional Zod field.
3. Call the new register fn from `buildMcpServer()` in `server.ts`.
4. Update _Files_ + _Module dependency graph_ in this context.

## Adding a resource

Same recipe as a tool — `src/resources<Name>.ts` with
`register<Name>Resources(server: McpServer): void`, called from
`buildMcpServer()`.
