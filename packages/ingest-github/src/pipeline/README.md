# `@bb/ingest-github/src/pipeline`

Orchestration plumbing shared by every strategy: cloning the source repo,
walking the working tree, resolving the branch, bounded concurrency, and a
minimal in-process cancellation registry. `pipeline/` knows nothing about LLM
prompts, file analysis, or graph writes — that lives under `strategies/`.

## Tier

Domain (sub-folder of `@bb/ingest-github`).

## Files

- `paths.ts` — commit-scoped on-disk layout resolver. `pathsFor(loc:
RepoLocation)` is the pure path builder (delegates to `plumblinePathsFor`
  in `@bb/types`). Every per-commit artifact lives under
  `~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/`
  with the clone in `repository/` and meta in `meta-output/`. For local
  knowledges the owner/repo segments collapse:
  `orgs/<orgId>/local/<knowledgeId>/<syntheticCommit>/`. The
  knowledgeId-keyed helpers (`metaRootFor`, `businessContextDir`,
  `orgRegistryDir`) are async — they look up `KnowledgeDoc` from the document store to
  derive the active `RepoLocation` before resolving the path. The legacy
  `repos/<id>/` + `repos/.meta/<id>/` layout is gone; `plumbline migrate
paths` walks old data into the new tree. Also exports
  `encodeMetaPath`/`decodeMetaPath` (slash/backslash → `__SL__`/`__BS__` so
  paths flatten to one file on disk).
- `source.ts` — `syncRepository({ repoUrl, branch, destinationDir, gitToken? })`.
  Clone-or-fetch+reset against `origin/<branch>`, `--depth=1`. The pull plan
  may later relax depth; ingestion does not need full history. Wraps git
  failures in `GitCloneError` (from `@bb/errors`). Note this is the
  GitHub-side primitive; GitLab knowledges use `@plumbline/ingest-gitlab`'s
  `cloneGitlabRepo` (oauth2 URL form, raises `GitlabCloneError`) via its
  `SourceFactory` and never enter this code path.
- `filters.ts` — `SKIP_DIRS`, `SKIP_FILES`, `BINARY_EXTENSIONS`, `looksBinary`,
  `passesPathFilters`. Now sourced from `skip-decisions/seed.ts`
  (`SEED_DIRECTORIES`/`SEED_FILENAMES`/`SEED_EXTENSIONS`) plus a small
  legacy literal block so the public scanner still rejects `.DS_Store`,
  lockfiles, and binary assets without requiring the seed JSON. Pure
  data; no I/O. `passesPathFilters` accepts an optional effective-sets
  argument (per-job ignore overrides, see `skip-decisions/effective.ts`);
  omitted → built-in defaults, behavior unchanged.
- `scan-helpers.ts` — `countLines` (fast LF counter) and `decisionKey`
  (content-hash dedupe key for the two-pass LLM batch). Extracted from
  `scan.ts` / `analyse-changed.ts`, which previously each carried a copy.
- `skip-decisions/` — LLM-backed unknown-extension gate. See
  `skip-decisions/README.md`. Active when `Config.SkipDecisionEnabled =
true` (default). Consumed by `scan.ts` via the optional `skipDecider`
  dep; built by `scanAndClassify` (Phase 1) if not injected.
- `disk-source-reader.ts` — `createDiskSourceReader({ repoDir, commitHash })`
  returns a `SourceReader` that wraps `scanRepository` + `node:fs.readFile`.
  The default reader the open-source binary always uses, unless the caller
  injects a `sourceFactory` (see `docs/extension-points.md`).
- `scan.ts` — async generator `scanRepository(rootDir, deps?)` yielding `ScanEntry`
  (`kind: "file"` or `kind: "oversized"`). A file is `oversized` when its
  byte size exceeds `Config.AbsoluteFileSizeCap` (skipped before read) or
  when its line count exceeds `Config.BigFileLineThreshold` (default 1200;
  enters the big-file phase). Both thresholds are config-driven — no
  magic numbers in this file. `deps.llmCallContext` (when present) is
  forwarded into every `SkipDeciderInput` so the LLM branch of the
  unknown-extension gate uses per-job credentials.

  **Two scan modes:**
  - **Two-pass (default for the flat-folder strategy)** — activated when
    `deps.skipDecider` AND `deps.limiter` are both supplied. Pass 1 walks
    the tree calling `decider.decideStatic(...)`; static-resolved files
    yield immediately, "needs LLM" files go into a pending buffer with
    their content. Pass 2 dedupes pending entries by `ext:<ext>` or
    `filename:<name>`, dispatches one `decider.decideAndDeferSave(...)` per
    unique key through the shared limiter via `Promise.all`, then calls
    `decider.persist()` exactly once. Pass 3 drains pending — every
    `decideStatic` call is now a cache hit, so the drain is sync at the
    decider boundary and yields each kept file with its buffered content.
  - **Legacy inline (`walk()`)** — used when `deps.limiter` is omitted (e.g.
    a custom `SourceFactory` consumer that didn't opt in). Inline `await
deps.skipDecider.decide(input)` per file. Same semantics as before this
    refactor; preserved for backwards compatibility.

  `readScannedFile` re-reads a file by absolute path for the big-file phase
  which streams content lazily.

- `run.ts` — `createPipelineRunner({ reposRootDir, strategy, sourceFactory?, progressContextFactory? })`
  builds an `IngestRunnerDeps`. GitHub payloads run: branch resolve,
  source-reader construction, strategy execute, commit persistence. Local
  payloads skip the clone. The source reader is chosen by the optional
  `sourceFactory` parameter: if undefined (open-source default), the
  runner builds a `DiskSourceReader` via `source.ts.syncRepository` +
  `readHeadCommitHash`. If a factory is supplied, the runner calls it
  with `{ knowledgeId, payload, branch }` and uses the returned reader +
  commit hash; the local clone is skipped. The factory may also return an
  `archiveSink` which the strategy then threads through to its
  analyse phase. **The runner calls `ensureCommitDirs(location)` in both
  branches** (after the factory returns, and before the non-factory
  `syncRepository`). This is idempotent — factories that pre-create the
  layout themselves see no effect — but mandatory: without it,
  `writeScanManifest` would ENOENT on its first write because the
  `meta-output/` parent dir wouldn't exist. For GitLab knowledges (which
  reach the runner via `@plumbline/ingest-gitlab`'s injected `SourceFactory`),
  `parseGithubRepo` accepts gitlab.com URLs so the `location` built from
  `parsed.owner` / `parsed.repo` resolves cleanly; subgroup gitlab URLs
  collapse to two segments at this layer and the factory itself uses the
  full namespace for the path it clones into. State transitions (`CREATED → QUEUED → INGESTED → …`) are
  persisted to SQLite + Neo4j via `transitionState`, and `CancellationError`
  is re-thrown without flipping to FAILED. The optional
  `progressContextFactory` is the runner's own `ProgressContext` source:
  `runGithub` emits `phaseChanged("clone")` before `syncRepository` (or before the
  `sourceFactory` call) and `phaseChanged("scan")` before invoking
  `strategy.execute`, so SSE clients see liveness during the
  network/disk-bound prelude. On a non-`CancellationError` throw the
  runner emits `failed(message)` only when the strategy has not yet
  started — once `strategy.execute` is reached, the strategy owns
  terminal emission and the runner stays silent to avoid double-FAILED.
  When the caller supplies an `IngestRunnerInput.usageGuard` (optional),
  the runner forwards it onto `StrategyInput.usageGuard` so the strategy
  can call `onPhaseComplete` between phases; if the strategy raises
  `UsageLimitExceededError`, the catch block invokes
  `usageGuard.flushPartial(cumulative)` before `classifyFailure` runs and
  `persistFailure` stamps category `usage_limit_exceeded`. With no guard
  wired the catch path is identical to today.
- `pull.ts` — `runPull(msg, pullFactory?, progressContextFactory?, usageGuard?)` orchestrates the pull job. Returns `Promise<PipelineSummary>` (was `Promise<void>`); the returned `tokenUsage` carries `inputTokens`, `outputTokens`, and `costUsd` summed across the pull phases for downstream callers that need to mirror the run into a knowledge record. Delegates the disk-fallback source/target resolution to `pull-source-resolver.ts` so the orchestrator stays under the file-size cap. The catch forwards `payload.isAutoPull` into `throwPullFailure` (see `pull-failure.ts`).
- `pull-failure.ts` — `throwPullFailure(cause, deps)` maps a thrown pull cause to the correct persisted state, then re-throws (never returns). Retryable → `persistHalted` + plain `IngestError` (queue retries); terminal → `persistFailure` + failure SSE + non-retryable throw. **`deps.isAutoPull`**: set for unattended auto-pull / bulk refresh of already-`PROCESSED` knowledge (downstream multi-tenant payloads only — OSS standalone never sets it). When true, on **any** failure it restores `PROCESSED` (`transitionState`), skips both `persistHalted`/`persistFailure` and the failure SSE, and throws non-retryable — so a failed background refresh never degrades a healthy index. Because the row stays `PROCESSED`, the downstream queue finalizer's HALTED→FAILED promotion is inert. The next sweep retries.
- `pull-source-resolver.ts` — `resolvePullSourceFromDisk(input)` builds a `SourceReader` + `DiffResult` + `targetCommit` triple by cloning (or fetch+resetting), reading branch HEAD, materialising the shallow clone, asserting branch ancestry, computing the diff, and checking out the target. Returns `{ noOp: true }` when the resolved target matches the previously-indexed commit so the caller can short-circuit to `PROCESSED`. Used only when `runPull`'s caller did not supply a `PullFactory`.
  Reads `repoUrl` and `branch` directly off `knowledge.info.*` (loaded via
  `@bb/db.knowledgeDb.getKnowledge`). The `KnowledgeSource` discriminator (`kind`) is
  still read off `knowledge.source` along with `commitId`/`commitHashes`, but
  the repo coordinates themselves live on `info` — no fallback chain.
  When `pullFactory` is provided, it returns `{source, diff, targetCommit,
archiveSink?}` and `runPull` skips `syncRepository` + `materialiseEndpoints`
  - `assertReachableFromBranch` + `computePullDiff` + `checkoutCommit` —
    the factory is the sole source of truth. When `pullFactory` is undefined
    (open-source default), the legacy git-based path runs. Either path
    produces the same downstream pipeline: snapshot prior version,
    `analyseChangedFiles` (now reading via `SourceReader`),
    `processBigFilesQueue`, `backfillMissingFields`,
    `runSelectiveFolderSummary`, `summariseRepo`, `storePullAnalysis`.
    Mirrors the index-side strategy orchestrator for progress: builds one
    `ProgressContext` per job from the optional `progressContextFactory`
    (default `nullProgressContextFactory`), emits `phaseChanged` at
    `file_analysis` / `folder_analysis` / `indexing` boundaries, threads
    the context into every phase that takes a `progressContext?` field,
    and finishes with `completed()` on success or `failed(message)` on a
    non-`CancellationError` throw. When an optional `usageGuard` is
    supplied, `runPull` invokes `onPhaseComplete(phase, cumulative)` after
    each token-consuming phase (`file_analysis_changed`,
    `big_file_analysis`, `folder_analysis`, `repo_summary`) and, on a
    raised `UsageLimitExceededError`, calls `flushPartial(cumulative)`
    before persisting the FAILED state.
- `stats.ts` — small shared helpers: `repoNameFromUrl` parses an owner/repo
  display name out of a GitHub URL with a graceful fallback, `localRepoName`
  derives a name from a local path, and `describe` flattens an `unknown`
  cause to a short string for `IngestError` messages. The previous
  `persistStats` write into the `processing_stats` collection has been
  removed — per-commit token and cost data now lives on the knowledge
  document's `source.commitHashes[]` (set by `setKnowledgeCommit` from
  `@bb/db`), with the per-call `costUsd` sourced directly from
  OpenRouter's `response.usage.cost`.
- `failure-classifier.ts` — `classifyFailure(cause)` returns
  `{ reason, category, detail? }` for any thrown ingestion error.
  `UsageLimitExceededError` → `usage_limit_exceeded` with the
  operator-readable reason "LLM token limit reached. Partial indexing was
  saved. Upgrade your plan to continue." and a `detail` carrying
  `phase=<...> current=<...> max=<...> cumulativeTokens=<...>` for
  triage. `LlmConfigError` → `llm_config`. `LlmError` is subdivided by
  its `status` field: `401`/`403` → `llm_auth`, `402` → `llm_quota`,
  `429` → `llm_rate_limit`, `5xx`/no-status → `llm_unreachable`. Anything
  else → `internal`. Each category produces a single short
  operator-readable `reason` sentence; the raw provider response body
  lives in `detail`. Used by `run.ts`/`pull.ts` catch blocks (document-store
  persistence via `markKnowledgeFailed`) and
  `strategies/flat-folder/index.ts` (SSE event via
  `progressContext.failed`) so both paths share one classification.
- `context.ts` — shared helpers to resolve pipeline organization IDs and parse
  optional LLM context parameter overrides from payload messages:
  `resolveOrgId(payload)` returns `payload.orgId ?? getConfigValue(Config.OrgId)`
  (the only place orgId is resolved), and `llmCallContextFromPayload(payload)`
  extracts the optional `{ llmApiKey, llmProvider, llmModel }` overrides
  from the payload and packs them into an `AskLlmOptions` bag stored on
  `StrategyContext.llmCallContext`.
- `branch.ts` — `resolveBranch(knowledgeId, payload)`. Defaults to `main` when
  the payload omits it; rejects branch names that don't match `^[\w./-]+$`
  with `IngestError` (defence against shell-injection into git args).
- `cancellation.ts` — in-process `Set<knowledgeId>` registry + `markCancelled`,
  `clearCancellation`, `isCancelled`, `throwIfCancelled`, `CancellationError`.
  Strategies call `throwIfCancelled(knowledgeId)` between sub-phases. The
  cancel HTTP route flips the bit; the orchestrator clears it on a
  `CancellationError` re-throw and leaves the knowledge state untouched (no FAILED).
- `concurrency.ts` — `withConcurrency(n)` returns a `limit(task)` function in
  the `p-limit` style. `runInPool(n, items, task)` is a convenience over async
  iterables. No external `p-limit` dependency.

## Imports allowed

- Sibling files in this folder may import each other.
- Down: `src/types/*` only (intra-package, via the `src/*` alias).
- Up: `@bb/config`, `@bb/types`, `@bb/errors`, `@bb/logger`, `node:*`.
- `run.ts` and `pull.ts` additionally import `@bb/db` and `@bb/neo4j`
  for state transitions and graph state writes respectively.
- `stats.ts` has no cross-package imports — it carries only pure helpers
  (`repoNameFromUrl`, `localRepoName`, `describe`).
- Forbidden: importing from `../strategies`, `../adapters`, `../handlers`.

## Invariants

- Every file is ≤ 300 lines.
- No graph traversal, no per-file document-store writes happen here — those live
  under `strategies/`. `run.ts` only performs end-of-pipeline state
  transitions and stats persistence. **Exception**: `skip-decisions/`
  uses `@bb/llm` for the unknown-extension YES/NO gate; this is the
  one LLM-touching path in `pipeline/` and is gated by
  `Config.SkipDecisionEnabled`.
- `scanRepository` never blocks the event loop on a large repo: it streams via
  `opendir` + per-file `readFile`; it never buffers the full tree.
- Tunable scan thresholds (`Config.AbsoluteFileSizeCap`,
  `Config.BigFileLineThreshold`) are read from `@bb/config` — never
  declared as in-file constants. Same for `Config.OrgId` in `run.ts`.
