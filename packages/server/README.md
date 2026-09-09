# `@bb/server` — context

## Tier

Binary (deployable). Sibling to `@bb/cli`. Imports everything below the
binary tier — `@bb/types`, `@bb/errors`, `@bb/config`, `@bb/db`, `@bb/sqlite`,
`@bb/neo4j`, `@bb/queue`, `@bb/ingest-github`. Never
imports `@bb/cli`.

## Responsibility

Single-process Express daemon backing the `plumbline` TUI. Per
[docs/arch.md:53-62](../../docs/arch.md#L53-L62): boots all infra in
order, registers queue workers in-process, exposes a small JSON HTTP
surface on `127.0.0.1`, single-tenant, no auth.

The package owns:

- Boot sequence — `loadConfig` validation → `connectDb` →
  `connectGraph` → `ensureKnowledgeIndexes` →
  `connectQueue` → `registerGithubWorkers` →
  `registerLocalIngestWorker` → `app.listen` → write
  `~/.plumbline/pid`.
- HTTP routes: `GET /health` (pings the document store + queue + graph),
  `POST /api/v1/github/index`, `POST /api/v1/local/index`,
  `GET /api/v1/repos`, plus the MCP routes (`POST|GET|DELETE /mcp`,
  `GET /sse`, `POST /sse/messages`) registered by `@bb/mcp`'s
  `mountMcp(app)` after the JSON routes.
- Knowledge-doc creation in **both** SQLite and Neo4j on each ingest
  request — `upsertKnowledge` + `upsertKnowledgeNode` run before the
  publisher transitions state to `QUEUED`.
- Filtered recursive copy for local ingest (`copyRepo.ts`) — files end
  up at `~/.plumbline/local-snapshots/<knowledgeId>/` (separate from the
  commit-scoped `orgs/` tree where analysed artifacts live). The
  snapshot freezes the user-supplied directory at submission time so
  edits made during the worker run don't bleed into ingestion. MCP
  retrieval for local knowledges reads through `source.sourcePath` on
  the `KnowledgeDoc`, not the snapshot.
- **Boot-time layout reconciliation** (`reconcileLegacyLayout`, [src/legacyLayout.ts](src/legacyLayout.ts)) —
  runs after `connectDb` (it needs the knowledge list). Delegates to
  `@bb/path-migration`: migrates every knowledge with a DB record into the
  commit-scoped layout, and **deletes legacy dirs that have no DB record**
  (logged to stderr as `legacy-layout abandoned …`) so a DB reset can't
  permanently block boot. Only throws `LayoutMigrationRequiredError` if legacy
  dirs remain that back a live knowledge but can't be migrated (missing
  `commitId` / `repoUrl`) — those carry data the server won't silently destroy.
- Graceful shutdown — SIGTERM/SIGINT → drain MCP sessions
  (`closeAllMcpSessions`) → close queue → close graph → close the
  document store → unlink `~/.plumbline/pid` → exit. MCP sessions drain
  first so in-flight Streamable HTTP / SSE transports release before
  the queue worker shuts down.

The package does **not** own:

- Worker handler bodies (those live in `@bb/ingest-github`)
- Knowledge / Raw schema (lives in `@bb/types` + `@bb/db-core`)
- Auth / rate-limit / CORS — single-tenant, localhost-only

## Public exports

`@bb/server` is a binary, not a library. The only contract is the `bin`
entry in `package.json`:

```jsonc
{ "bin": { "plumbline-server": "./src/index.ts" } }
```

The TypeScript exports (route builders, shutdown installer) are
**internal** — no other workspace package imports `@bb/server`.

## Routes

```
GET  /health                  → 200 { status: "ok", db, queue, graph }
                              → 503 { status: "down", … }

POST /api/v1/github/index     body: { repoUrl, branch?, gitToken? }
                              → 200 { knowledgeId, jobId }
                              → 400 invalid body / repoUrl format

POST /api/v1/local/index      body: { sourcePath: <abs> }
                              → 200 { knowledgeId, jobId }
                              → 400 missing / not exists / not a directory
                              → 422 sourcePath must be absolute

GET  /api/v1/repos            → 200 { repos: [...] }   (sorted updatedAt desc)
GET  /api/v1/repos/:id        → 200 { knowledgeId, state, fileCount, totalFiles,
                                      processedFiles, progressPercent, currentPhase,
                                      failure } (powers CLI poll/progress bar)
                              → 404 knowledge not found

POST|GET|DELETE /mcp                       Streamable HTTP — owned by @bb/mcp
GET  /sse                                  legacy SSE stream — owned by @bb/mcp
POST /sse/messages?sessionId=…             legacy SSE messages — owned by @bb/mcp
```

## Data ownership

- `~/.plumbline/pid` — written at boot (mode `0644`), removed on graceful
  shutdown. Stale PID file is the signal that an earlier run crashed.
- `~/.plumbline/local-snapshots/<knowledgeId>/` — populated by the
  local-ingest route's `copyRepo`. Frozen snapshot of the user's
  uploaded directory at submission time. Persisted across job retries;
  never auto-deleted. GitHub ingestion does not use this dir — it
  clones directly into the commit-scoped `orgs/<orgId>/github/<knowledgeId>/<owner>/<repo>/<commit>/repository/`
  tree (owned by `@bb/ingest-github`).

## Invariants

1. **Bind localhost only.** `app.listen(port, "127.0.0.1")`. v0 OSS is
   single-tenant local — no remote connections.
2. **Boot fails fast on missing config.** Required keys are
   `Config.SqlitePath`, `Config.QueueDbPath`, `Config.Neo4jUri`,
   `Config.Neo4jUser`, `Config.Neo4jPassword`,
   `Config.OpenrouterApiKey`. Missing → `ServerConfigError` with the
   matching `plumbline set …` hints, exit 1.
3. **Knowledge doc creation precedes enqueue and is dual-written.** Each
   ingest route calls `upsertKnowledge` (SQLite) + `upsertKnowledgeNode`
   (Neo4j) with `state: CREATED` before the publisher
   (`enqueueGithubIndex` / `enqueueLocalIngest`). The publisher's
   `setKnowledgeState(_, QUEUED)` then transitions the doc.
   3a. **Neo4j schema bootstrap runs once at boot.** `ensureKnowledgeIndexes`
   creates uniqueness constraints for `:Knowledge / :File / :Keyword /
:Class / :Function / :Module`; tolerant of existing indexes.
4. **Local ingest copies into `local-snapshots/`, not in-place.** The
   user's `sourcePath` is read-only; the snapshot at
   `~/.plumbline/local-snapshots/<knowledgeId>/` freezes the tree the
   worker sees. MCP retrieval for local knowledges reads from
   `KnowledgeDoc.source.sourcePath` (the original, unfrozen path) —
   the snapshot exists purely to give the worker a stable input.
   4a. **Legacy layout is reconciled automatically at boot.** After `connectDb`,
   the server runs `reconcileLegacyLayout` (`@bb/path-migration`): legacy
   `repos/.meta/` + `repos/<id>/` dirs with a DB record are migrated to the
   commit-scoped `orgs/` tree; dirs with no DB record are deleted and logged as
   abandoned. Boot only throws `LayoutMigrationRequiredError` (non-zero exit)
   when legacy dirs remain that back a live knowledge but can't be migrated
   (missing `commitId` / `repoUrl`); `plumbline migrate paths` runs the same
   reconciliation ahead of time or with `--dry-run`.
5. **Filtered copy uses the same SKIP lists as `scan.ts`.** Lists are
   duplicated (small, stable) rather than imported across the
   infra/domain boundary.
6. **No env reads.** All config flows through `@bb/config`.
7. **PID file is best-effort.** Write fails are logged but don't block
   boot; unlink fails on shutdown are swallowed.

## External dependencies

- `express@5` — HTTP server
- `@types/express` (dev)
- Workspace deps: `@bb/config`, `@bb/errors`, `@bb/types`, `@bb/db`, `@bb/sqlite`,
  `@bb/neo4j`, `@bb/queue`, `@bb/ingest-github`

## What is intentionally out of scope (v0)

- Auth / rate-limiting / CORS — localhost-only single-tenant
- OpenAPI schemas per [CLAUDE.md _Rule of API Logging & Documentation_](../../CLAUDE.md) — defer
- Tar-streaming for `/api/v1/local/index` — JSON `{ sourcePath }` is
  enough for local CLI/server co-location
- Streaming progress responses — caller polls `/api/v1/repos`
- `plumbline server stop | status | logs` — defer; user can
  `kill $(cat ~/.plumbline/pid)`
- `DELETE /api/v1/repos/:knowledgeId` (powers `plumbline clean`) — defer
- `GET /api/v1/repos/:knowledgeId` (single-doc read with file list) — defer

## How to extend

Adding a new route:

1. Create `src/<name>Route.ts` exporting a `build<Name>Route(): Router`.
2. Use the `express.Router()` pattern consistently. Validate the body
   with manual `if` checks (no zod dep — the route layer is thin).
3. Register in `src/routes.ts`'s `registerRoutes(app)`.
4. Update _Routes_ + _Public exports_ in this file.

Adding boot infra:

1. Add the `connect*` call to `src/index.ts`'s `main()` in correct order
   (config → db → graph → schema bootstrap → queue → workers
   → listen → pid).
2. Add the matching `close*` call to `src/shutdown.ts` in reverse
   order, before the `unlink ~/.plumbline/pid`.
3. Update _Invariants_ if the new infra changes the boot contract.
