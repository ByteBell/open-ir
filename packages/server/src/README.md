# `@bb/server/src` — context

Implementation of `@bb/server`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

## Files

- **[index.ts](index.ts)** — binary entry. Shebang `#!/usr/bin/env bun`.
  Runs `checkRequiredConfig()` (throws `ServerConfigError` with the
  missing keys + matching `plumbline set …` hints); awaits the four
  `connect*` calls (db → graph → queue), runs
  `reconcileLegacyLayout()` right after the db connect (see
  [legacyLayout.ts](legacyLayout.ts)), and runs `ensureKnowledgeIndexes()`
  between neo4j connect and queue connect;
  calls both worker registrations; installs shutdown handlers;
  constructs the express app with `express.json({ limit: "1mb" })`;
  binds to `127.0.0.1`; writes `~/.plumbline/pid`. On any error during
  boot: prints to stderr and exits 1.
- **[legacyLayout.ts](legacyLayout.ts)** — `reconcileLegacyLayout()`, called
  after `connectDb`. Lists knowledge via `@bb/db`, delegates the disk work to
  `@bb/path-migration` (migrate recoverable, abandon orphans), logs migrated /
  abandoned, and throws `LayoutMigrationRequiredError` only if un-migratable
  dirs with a live DB record remain.
- **[routes.ts](routes.ts)** — single `registerRoutes(app)` that mounts
  every `Router` on the express app, then calls `mountMcp(app)` from
  `@bb/mcp` to register the MCP transport routes (Streamable HTTP at
  `/mcp` plus legacy SSE at `/sse` + `/sse/messages`). Add a new line
  per route.
- **[healthRoute.ts](healthRoute.ts)** — `GET /health`. Awaits
  `pingDb()` + `pingQueue()` + `pingGraph()` in parallel; 200 if all
  three ok, 503 otherwise. Body includes all three ping results for
  debugging.
- **[githubIndexRoute.ts](githubIndexRoute.ts)** — `POST
/api/v1/github/index`. Manual body validation (`repoUrl` non-empty
  string + `^https?://`). Mints `crypto.randomUUID()`, builds a
  `KnowledgeDoc`, dual-writes via `upsertKnowledge` (SQLite) +
  `upsertKnowledgeNode` (Neo4j), then `enqueueGithubIndex` (the
  publisher transitions the knowledge state to `QUEUED`). Returns
  `{ knowledgeId, jobId }`.
- **[localIndexRoute.ts](localIndexRoute.ts)** — `POST
/api/v1/local/index`. Validates `sourcePath` is non-empty / absolute
  / exists / is a directory. Mints `knowledgeId`, mkdirs
  `~/.plumbline/repos/`, calls `copyRepo(sourcePath, destDir)`, then
  dual-writes `upsertKnowledge` + `upsertKnowledgeNode`, then
  `enqueueLocalIngest`. Returns `{ knowledgeId, jobId }`.
- **[reposRoute.ts](reposRoute.ts)** — `GET /api/v1/repos`. Calls
  `listKnowledge()` (default limit 200, sorted updatedAt desc), maps
  Date fields to ISO strings, returns `{ repos: [...] }`.
- **[copyRepo.ts](copyRepo.ts)** — recursive filtered
  `node:fs/promises.cp` helper. Hardcoded `SKIP_DIRS` / `SKIP_FILES`
  mirror `@bb/ingest-github`'s `scan.ts` (duplication accepted —
  small, stable lists; importing across the package boundary would
  muddy the tier graph).
- **[shutdown.ts](shutdown.ts)** — `installShutdownHandlers()` registers
  SIGTERM and SIGINT handlers. The handler awaits
  `closeAllMcpSessions → closeQueue → closeGraph → closeDb` then unlinks
  `~/.plumbline/pid`. MCP sessions drain first
  so in-flight Streamable HTTP / SSE transports release before any
  worker- or driver-level connection closes. 30-second timeout (via
  `setTimeout.unref()` so it doesn't keep the process alive); on
  timeout exits 1 (PID file may remain — that's the signal a crash
  happened).

## Module dependency graph

```
healthRoute.ts        → express, @bb/db (pingDb), @bb/queue (pingQueue),
                        @bb/graph-db (pingGraph)
githubIndexRoute.ts   → express, @bb/types (KnowledgeState, KnowledgeDoc),
                        @bb/db (knowledgeDb.upsertKnowledge),
                        @bb/neo4j (upsertKnowledgeNode),
                        @bb/queue (enqueueGithubIndex)
localIndexRoute.ts    → express, node:fs/promises, node:path,
                        @bb/config (getPlumblineHome),
                        @bb/types (KnowledgeState, KnowledgeDoc),
                        @bb/db (knowledgeDb.upsertKnowledge),
                        @bb/neo4j (upsertKnowledgeNode),
                        @bb/queue (enqueueLocalIngest), copyRepo.ts
reposRoute.ts         → express, @bb/db (knowledgeDb.listKnowledge)
copyRepo.ts           → node:fs/promises, node:path
routes.ts             → express, all four route builders, @bb/mcp (mountMcp)
shutdown.ts           → node:fs/promises, node:path, @bb/db (closeDb),
                        @bb/graph-db (closeGraph),
                        @bb/queue (closeQueue), @bb/mcp (closeAllMcpSessions),
                        @bb/config (getPlumblineHome)
index.ts              → express, node:fs/promises, node:path, @bb/types (Config),
                        @bb/config (getPlumblineHome, getConfigValue, HINTS),
                        @bb/db (connectDb), @bb/sqlite,
                        @bb/graph-db (connectGraph, ensureKnowledgeIndexes),
                        @bb/queue (connectQueue),
                        @bb/ingest-github (registerGithubWorkers, registerLocalIngestWorker),
                        @bb/errors (ServerConfigError),
                        routes.ts, shutdown.ts
```

No cycles.

## Invariants enforced here

- **Boot ordering is load-bearing.** `connectDb` must come before
  any worker registration; `connectNeo4j` before
  `ensureKnowledgeIndexes`; `connectQueue` before `registerWorker`; the
  PID file write happens last (only after `app.listen` resolves).
- **`Knowledge` doc is dual-written before enqueue.** Every ingest
  route runs `upsertKnowledge({ state: CREATED })` (SQLite) and
  `upsertKnowledgeNode(doc)` (Neo4j) before its publisher call. If
  either upsert throws, no job is ever enqueued.
- **Copy precedes enqueue for local.** The local-ingest worker assumes
  `rootDir` is fully populated. Server's `copyRepo` runs to completion
  before `enqueueLocalIngest`.
- **Routes are thin.** Body validation, ID minting, two upserts, one
  enqueue, JSON response. No business logic. Anything heavier moves
  into `@bb/ingest-github` or a future service package.
- **Health pings all three.** `/health` reports the status of the document
  store, the queue, AND the graph; 503 if any one is down.
- **No `process.env` reads.** All config via `@bb/config`.

## Adding a route

Follow the recipe in [../README.md](../README.md) under _How to
extend_. New files live as flat `src/<name>Route.ts` (the repo ESLint
rule forbids parent traversal — keep `src/` flat).
