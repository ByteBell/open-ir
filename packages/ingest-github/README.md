# `@bb/ingest-github` — context

## Tier

Domain. Depends on Kernel (`@bb/types`, `@bb/errors`), Infrastructure
(`@bb/config`, `@bb/db`, `@bb/neo4j`), Cross-cutting (`@bb/llm`), and
Strategy (`@bb/queue`). May be imported by Binaries (`@bb/server` calls
`registerGithubWorkers()` and `registerLocalIngestWorker()` once at
boot). Never by `@bb/cli`.

## Responsibility

Consumes `JobType.GithubIndex` and `JobType.LocalIngest` jobs published
by `@bb/queue`. For each job, runs the active `IngestionStrategy`
(selected via `Config.IngestionStrategy`: `flat-folder` default, or
`concept-graph` for the hypergraph-enrichment strategy) over the cloned
source tree at
`~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/repository/`
and persists per-file results to SQLite (`raw_files` table via
`@bb/db`) **and** Neo4j (`:File` nodes + `:HAS_KEYWORD` /
`:HAS_CLASS` / `:HAS_FUNCTION` / `:HAS_IMPORT_INTERNAL` /
`:HAS_IMPORT_EXTERNAL` rels via `@bb/neo4j`).

The package owns:

- The `github_index` and `local_ingest` worker handlers (registered via
  `@bb/queue.registerWorker`)
- The git clone / fetch lifecycle for one repo per knowledge ID. Commit
  SHA is resolved via the GitHub REST API (`fetchLatestCommitHash`)
  _before_ clone so the clone lands directly in the commit-scoped
  `repository/` directory — no staging rename. Older commits' trees
  stay alongside the current head for forensic comparison.
- The hardcoded ignore list (directories, lockfiles, binary extensions,
  size cap) for repo scanning
- The 9-field per-file LLM analysis prompt (small-file path) and the
  chunked + condensed analysis path for files above the token threshold.
  Field definitions live in `FILE_ANALYSIS_FIELDS_BLOCK` (single source
  of truth; wording adapted from kube-package's
  `fileAnalysisFieldDefs.ts`)
- Translation of LLM output JSON → `RawFileDoc` shape (SQLite) **and**
  `:File` graph node + entity relationships (Neo4j), with safe fallbacks
  for malformed responses
- Knowledge `status.state` transitions (`Processing` on start,
  `Processed` on success, `Failed` on caught error) — kept in lock-step
  between SQLite and Neo4j via a shared `transitionState` helper
- The `IngestionStrategy` pluggable abstraction — the worker delegates
  the post-clone scan/analyze/persist loop to a strategy instance.
  v1 ships one concrete: `BasicFileAnalysisStrategy`

The package does **not** own:

- The `github_pull` worker handler (deferred — the publisher exists in
  `@bb/queue` but no consumer yet)
- Folder-level summarization (out of scope per OSS strategy; future
  strategies can add this)
- Semantic chunking, big-file processing, smart sampling (future
  strategies)
- Recovery / failed-files tracking
- Progress **transport** — the package now ships a `ProgressContext`
  extension port under `src/progress/` (see that folder's README), but
  the actual SSE / Pub-Sub plumbing lives in the host binary's progress
  package. The OSS default (`nullProgressContextFactory`) discards every
  event, consistent with the no-outbound-calls posture.
- Provider abstraction (no Bitbucket support; GitHub-only)
- Concurrency control (sequential per-file processing intentional for
  v0; revisit when users complain)

The optional `sourceFactory` lets downstream consumers inject a custom
`SourceReader` for index jobs (no local clone). The analogous
`pullFactory` does the same for pull jobs — its result carries the
resolved `targetCommit`, the diff between currentCommit and targetCommit,
and a reader pinned at the target. When unset, both fall back to the
default disk-backed paths (`git clone` for index, `git fetch + diff +
checkout` for pull). See [docs/extension-points.md](docs/extension-points.md)
for the design rationale.

For per-job LLM credentials, downstream consumers set
`{ llmApiKey?, llmProvider?, llmModel?, llmKeyId? }` on the
`GithubIndexPayload` / `GithubPullPayload` they enqueue
(`PayloadLlmOverrides` from `@bb/types`). The runner extracts those into
`StrategyContext.llmCallContext` and every LLM call site forwards it to
`@bb/llm`. `llmProvider` is `string` (open) so multi-provider consumers
can carry richer taxonomies; the OSS LLM client narrows to
`openrouter`/`ollama` at the boundary. OSS standalone leaves the overrides
unset and falls back to `Config.OpenrouterApiKey` + `Config.LlmProvider`.

For runtime token-quota enforcement, an optional `UsageGuard` (from
`@bb/types`) can be threaded per job. `IngestJobHandlerDeps` accepts a
`usageGuardFactory: (payload) => UsageGuard | undefined`; `runPull`
accepts a `usageGuard` as its 4th argument; and `IngestRunnerInput`
exposes `usageGuard?` directly. The pipeline calls
`onPhaseComplete(phase, cumulative)` after every token-consuming phase
(`file_analysis`, `folder_analysis`, `repo_summary`, plus the pull
equivalents `file_analysis_changed` and `big_file_analysis`). A guard
implementation may throw `UsageLimitExceededError` (from `@bb/errors`) to
abort the run; the pipeline's catch path then invokes
`flushPartial(cumulative)` once and persists a `FAILED` knowledge state
with category `usage_limit_exceeded`. OSS standalone leaves the guard
unset — every hook call short-circuits via `await usageGuard?.…` and
behavior is identical to today.

Both `register*Workers()` calls run once at `@bb/server` boot. The
worker picks the active `IngestionStrategy` based on
`Config.IngestionStrategy`:

- `flat-folder` (default) — produces `:Repo` + `:Folder` summaries
  alongside `:File` analysis. The historic 7-phase pipeline.
- `concept-graph` — drops `:Folder`/`:Repo` and runs per-file MCP
  enrichment in their place, emitting `:Concept` / `:Contract` /
  `:Guidepost` hypergraph nodes. See
  `src/strategies/concept-graph/README.md`.

Adding another strategy = new sibling folder under `src/strategies/`
plus a branch in `pickStrategy()` in `src/index.ts`.

## Data ownership

- `~/.plumbline/orgs/<orgId>/github/<knowledgeId>/<owner>/<repo>/<commit>/repository/`
  — the cloned working tree for each indexed commit (for `github_index`
  / `github_pull`). Persisted across job retries (clone is idempotent:
  `git fetch + reset` if `.git` exists). Each commit gets its own
  self-contained snapshot — older commits' trees stay alongside the
  current head until the operator prunes. Local ingest jobs do NOT
  populate this dir; they read from `KnowledgeDoc.source.sourcePath` (the
  user's original directory) directly. Never deleted automatically —
  `plumbline clean` per [docs/arch.md:157](../../docs/arch.md#L157)
  will own removal.
- The Knowledge document's `status.state` field — written via
  `setKnowledgeState` from `@bb/db` AND
  `setKnowledgeStateInGraph` from `@bb/neo4j`, kept in lock-step.
- Raw documents (one per scanned file) — written via `upsertRawFile`
  from `@bb/db`. Compound key `(knowledgeId, relativePath)`.
- `:File` graph nodes + `:HAS_FILE` / `:HAS_KEYWORD` / `:HAS_CLASS` /
  `:HAS_FUNCTION` / `:HAS_IMPORT_INTERNAL` / `:HAS_IMPORT_EXTERNAL` relationships — written via
  `upsertFileNode` from `@bb/neo4j`.
- `meta-output/scan-manifest.json` — the canonical small/big/oversized
  classification produced by Phase 1 (`scanAndClassify`). Per-file entries
  carry `tokenCount`, `kind`, and (for big files) `estimatedChunks`.
  Phases 2a (small) and 2b (big) consume the manifest in parallel.
- `meta-output/bigFiles.json` — legacy view written alongside the manifest
  for the pull-path and backfill phases. The main strategy no longer
  consumes it directly.
- `FileAnalysisCache` (in-memory only, not persisted) — single
  `Map<relativePath, CondensedFileAnalysis>` loaded once between the
  analyse and backfill phases via parallel `readdir + readFile`. Replaces
  three sequential `iterateCondensed` walks (phases 3, 5, 7) with one
  parallel preload + three in-memory iterations. The pull workflow loads
  its own cache instance; only one strategy run owns a given
  `metaPaths` directory at a time. For repos beyond ~50k analysed files
  consider a streaming-mode fallback (not implemented today).

## Invariants

1. **Shared LLM concurrency limiter.** The flat-folder strategy
   constructs one `withConcurrency(Config.LlmConcurrency)` instance at
   entry (default 29). The small-file phase, the big-file chunk phase,
   per-file condense calls, **and the folder-summary phase** all check
   out from this single pool, so total in-flight LLM calls is bounded
   by one knob. The pull-path constructs its own shared limiter at
   `runPull` entry and threads it into the selective folder-summary
   phase. The legacy `processBigFile` driver used by the pull-path
   still uses its own per-file pool sized by `Config.BigFileConcurrency`.
2. **Folder-summary batching by default.** Phase 5 groups small folders
   (`≤ Config.FolderSummaryBatchMaxFiles`, default 15) into batches of
   up to `Config.FolderSummaryBatchSize` (default 10) and asks the LLM
   for one JSON object keyed by integer label that returns one summary
   per folder. Bigger folders take the individual single-folder path.
   Roll back to one LLM call per folder via
   `plumbline set folder.summary.batch.size 1`.
3. **Clone idempotent.** Re-runs (queue retries) call `git fetch` +
   `git reset --hard` in the existing dir rather than re-cloning.
   Tokens are re-injected into the remote URL each time.
4. **Token redaction.** `GitCloneError` carries the **redacted** repo
   URL (`https://user:***@host`) — the raw `gitToken` never appears in
   error messages or logs.
5. **State transition order.** `Processing` is set _before_ any clone
   work. `Processed` is set _only_ after the entire scan + analyze loop
   completes. On any thrown error, the handler best-effort sets `Failed`
   then re-throws so the queue records the retry.
6. **Fail-soft analysis, fail-hard infra.** A single file's LLM call
   failing falls back to an empty-analysis Raw doc and processing
   continues. In the big-file path, a single chunk failure contributes
   an empty analysis to the merge but does not stop the file; a
   condensation-call failure falls through to deterministic
   `dedupAnalyses` so the merged result is always well-formed. A clone
   failure or document-store write failure throws and propagates to the queue for
   retry under the queue's `attempts: 3`.
7. **Hardcoded filters only.** No LLM-based ignore decisions in v0. The
   directory / file / extension blocklists in `scan.ts` are the only
   way files get skipped.

## External dependencies

- Node built-ins only: `node:child_process` (git), `node:fs/promises`
  (walk), `node:crypto` (sha-256), `node:path`, `node:util`
- Workspace deps: `@bb/config`, `@bb/errors`, `@bb/llm`, `@bb/db`,
  `@bb/neo4j`, `@bb/queue`, `@bb/types`
- System binary: **`git`** must be on the user's `PATH`. Documented in
  the project README as a runtime prerequisite.

## What is intentionally out of scope (v0)

- `github_pull` worker (`enqueueGithubPull` jobs sit in the queue until
  this lands; the existing strategy interface accepts it cleanly)
- Bitbucket / GitLab support
- GitHub API streaming mode (always shell-clone)
- Default-branch auto-detection (caller supplies `branch`; defaults to
  `"main"`)
- Folder-level summaries / `repoSummary.json` / `flat-folder` strategy
- Semantic chunking (`SemanticChunker`)
- Per-chunk persistence (we persist only the merged file-level
  `FileAnalysis`; future MCP retrieval may want per-chunk Raw docs and
  `:Chunk` Neo4j nodes — non-breaking add)
- Smart file processor tiers (FULL / SMART_SAMPLE / METADATA_ONLY)
- Recovery / `ProcessingStateManager`
- Progress reporting / heartbeats
- Failed-files tracker
- Adaptive memory manager
- Comprehensive 17-field LLM analysis (we ship 9: `purpose`, `summary`,
  `businessContext`, `language`, `classes`, `functions`,
  `importsInternal`, `importsExternal`, `keywords`)
- Model escalation
- LLM-based ignore decisions
- Cost ledger (the `@bb/llm` package itself doesn't have one yet)
- Auto-cleanup of the `~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/`
  commit-scoped tree (clones + meta-output)

## How to extend

Adding a new strategy (the primary extension point):

1. Create `src/<MyStrategy>.ts` exporting a class that
   `implements IngestionStrategy`. Its `ingest({ knowledgeId, rootDir })`
   is invoked once per job after the source files have landed at
   `rootDir`.
2. Compose any of the existing helpers — `walkRepo`, `analyzeFile`,
   `upsertRawFile`, `upsertFileNode`, `askLLM` — or do something
   completely different.
3. In `src/worker.ts`, change
   `const STRATEGY = new BasicFileAnalysisStrategy()` to your class.
   (Or, when richer wiring is needed, introduce a registry — out of
   scope for v1.)
4. Re-export from `src/index.ts` if other packages should be able to
   reference it directly.

Adding the `github_pull` worker:

1. Create `src/worker-pull.ts` with a `handleGithubPull` function:
   `git pull origin <branch>` → `git diff --name-only <prevSha>..HEAD`
   → invoke a `Strategy` (likely the same `BasicFileAnalysisStrategy`)
   over a smaller scoped subset of files → delete Raw + graph entries
   for files removed in the diff (needs `deleteRawFile` and
   `deleteFileNode` helpers in `@bb/db` / `@bb/neo4j`).
2. In `src/worker.ts`'s `registerGithubWorkers`, also call
   `registerWorker(JobType.GithubPull, handleGithubPull)`.
3. Update _Public exports_ / _Out of scope_ here.

Driving a pull with an out-of-tree strategy:

The `github_pull` worker (`runPull`) is hardcoded to the flat-folder
analysis phases. An out-of-tree strategy that needs its own incremental
pull (a private downstream strategy) does **not** fork `runPull`;
instead it reuses the strategy-agnostic pull prelude re-exported from
`index.ts`'s strategy-agnostic pull prelude — `preflightPull`, `resolvePullSource`,
`transitionState`, `emptyPullSummary`, `recordPullCommit`,
`throwPullFailure`, and the `context.ts` builders (`resolveOrgId`,
`ignoreSetsFromPayload`, `llmCallContextFromPayload`,
`unitsLlmCallContextFromPayload`, `withUsageMeter`) — and swaps only the
analysis step for its own `IngestStrategy.execute()`. All lifecycle DB
writes stay in this package via `recordPullCommit` / `transitionState`.

Adding concurrency:

1. Pull `Config.ConcurrencyGithub` from `@bb/config` inside the
   strategy's `ingest()`.
2. Replace the `for await` loop with a bounded-parallel implementation
   (small inline `pLimit` style).
3. Document the new max-concurrency invariant.
