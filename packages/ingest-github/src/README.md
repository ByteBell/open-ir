# `@bb/ingest-github/src` — context

Implementation of `@bb/ingest-github`. See [../README.md](../README.md) for
the package-level contract; this file documents how the source tree is split
under the v2 flat-folder strategy.

## Tier

Domain (composes infra: `@bb/config`, `@bb/llm`, `@bb/db`, `@bb/neo4j`,
`@bb/queue`, `@bb/logger`, `@bb/types`, `@bb/errors`).

## Top-level files

- **[index.ts](index.ts)** — public surface. The high-level
  registration helpers (`registerGithubWorkers`, `registerLocalIngestWorker`)
  for the OSS standalone, plus the lower-level building blocks downstream
  consumers wire against their own queue/registry:
  - Factories: `createFlatFolderStrategy`, `createLlmFileAnalyzer`,
    `createDiskSourceReader`, `createPipelineRunner` (the orchestrator),
    `createGithubIngestHandler` / `createLocalIngestHandler` (the queue
    processor factories used internally by `registerGithubWorkers`).
  - Direct runner: `runPull(msg, pullFactory?, progressContextFactory?, usageGuard?)`
    — the pull worker downstream consumers invoke directly from their
    own registry.
  - Helper: `reposRoot()` — resolves `~/.plumbline/repos`.
  - Path resolvers: `pathsFor(loc)`, `orgsRoot()`, `ensureCommitDirs(loc)`,
    `metaRootFor(knowledgeId)`, `businessContextDir(...)`,
    `orgRegistryDir(...)`, plus the `RepoLocation` type. `ensureCommitDirs`
    is exported so downstream `SourceFactory` consumers (e.g.
    `@plumbline/ingest-gitlab`) can pre-create the commit-scoped
    `repository/` + `meta-output/` tree before cloning into it. The runner
    also calls it inside the `sourceFactory !== undefined` branch so any
    factory consumer is safe even without pre-creating dirs itself
    (`writeScanManifest` would otherwise ENOENT on its first write).
  - Port types: `SourceReader` / `ScanEntry` / `ScannedFile` /
    `OversizedFile` / `ScanDeps` / `ArchiveSink` / `ArchiveSinkInput` /
    `SourceFactory` / `SourceFactoryInput` / `SourceFactoryResult` /
    `PullFactory` / `PullFactoryInput` / `PullFactoryResult` /
    `PipelineSummary` (the index/pull return value carrying `commitHash`,
    `tokenUsage: { inputTokens, outputTokens, costUsd }`, `filesAnalyzed`,
    `foldersSummarised`, `repoSummarised`, `graphNodesWritten` —
    downstream consumers use it to mirror telemetry into their own stores) /
    `DiffResult` / `RenamedFile` / `FileAnalyzer` / `AnalyzedFileResult`.
  - Runner types: `IngestRunnerDeps` / `IngestRunnerInput` /
    `IngestJobHandlerDeps` / `CreatePipelineRunnerDeps`.
  - Strategy types: `IngestStrategy` / `StrategyInput` / `StrategyResult` /
    `StrategyContext`.
  - `CondensedFileAnalysis`.
  - GitHub helpers: `parseGithubRepo` / `fetchLatestCommitHash` /
    `fetchRecentCommits`.
    `registerGithubWorkers` accepts optional `sourceFactory` (index) and
    `pullFactory` (pull) injections through `RegisterGithubWorkersDeps`;
    the open-source binary leaves both undefined. It registers both
    `JobType.GithubIndex` (full re-index, via `runner.run` + optional
    `sourceFactory`) and `JobType.GithubPull` (incremental diff-and-apply
    via `runPull` + optional `pullFactory`). Downstream consumers that
    bring their own queue skip `registerGithubWorkers` entirely and call
    `createPipelineRunner`, `createGithubIngestHandler`, and `runPull`
    directly.
- **[githubApi.ts](githubApi.ts)** — `parseGithubRepo(repoUrl)` and
  `fetchLatestCommitHash(owner, repo, branch, gitToken?)`. **Pull-only
  utility**; revisit in the pull plan. Kept in place rather than deleted so
  the pull route can be revived without code archaeology.
  `parseGithubRepo` accepts both `github.com` and `gitlab.com` hostnames so
  the runner can construct a kube-v2 `RepoLocation` for GitLab knowledges
  that route through this pipeline via an injected `SourceFactory`. The
  kernel `RepoLocation` only has a `github` provider variant today; gitlab
  projects therefore share the github path segment on disk. Subgroup gitlab
  URLs (`group/sub/project`) collapse to `{ owner: group, repo: sub }` in
  this pull-only helper. For the knowledgeId-keyed resolver
  ([pipeline/paths.ts](pipeline/paths.ts) `repoLocationFor`) — which the
  business-context reader uses — gitlab.com URLs now go through the
  subgroup-aware `parseGitlabOwnerRepo` in `@bb/types/src/path-layout.ts`
  (`owner="group/sub"`, `repo="project"`) so the read path matches the GitLab
  source-factory's `deriveOwnerRepo` and resolves the same on-disk directory
  for nested projects.
- **[README.md](README.md)** — this file.

## Subtrees

- **[types/](types/README.md)** — type-only barrel + zero-cost factories.
  `IngestStrategy`, `StrategyInput`, `StrategyResult`, `StrategyContext`,
  `FileAnalyzer` port, `ScanEntry`, `CondensedFileAnalysis`, `BigFileEntry`,
  `MetaPaths`, `emptyFileAnalysis`, `FALLBACK_LANGUAGE`.
- **[pipeline/](pipeline/README.md)** — orchestration plumbing: clone,
  scan, filters, branch resolve, bounded concurrency, in-process cancel
  registry, plus `pipeline/run.ts` which is the orchestrator that wraps a
  strategy with state transitions, clone, meta-dir setup, stats persistence,
  and commit anchoring.
- **[adapters/](adapters/README.md)** — `createLlmFileAnalyzer(deps)`
  returns the `FileAnalyzer` port; prompts are injected by the strategy.
- **[payload/](payload/README.md)** — defensive narrowing of queue
  payloads and `isEnvelopeCoherent`.
- **[handlers/](handlers/README.md)** — queue entry shells; pure
  validation + delegate to the runner.
- **[strategies/](strategies/README.md)** — one subfolder per strategy.
  Currently `flat-folder/` (active) and `basic-file-analysis/` (archived).

## Module dependency graph (abridged)

```
types/                       → @bb/db-core (FileAnalysis), @bb/types
pipeline/                    → types/, @bb/config, @bb/types, @bb/errors,
                               @bb/llm (tokenizer), node:*
adapters/                    → types/, @bb/llm, @bb/db, @bb/logger
payload/                     → @bb/types, @bb/errors
handlers/                    → types/, payload/, @bb/types, @bb/errors
strategies/flat-folder/      → types/, pipeline/, adapters/, @bb/llm,
                               @bb/db, @bb/neo4j, @bb/logger, @bb/config,
                               @bb/types, @bb/errors
pipeline/run.ts              → types/, pipeline/*, @bb/db, @bb/neo4j,
                               @bb/llm, @bb/errors, @bb/logger, @bb/types
index.ts                     → handlers/, pipeline/run.ts, strategies/flat-folder/,
                               adapters/, githubApi.ts, @bb/queue, @bb/types,
                               @bb/errors, @bb/logger
```

Tier flow is strict: `types/` is the leaf; `pipeline/`, `adapters/`,
`payload/`, `handlers/` may import `types/` but not each other or
`strategies/`; `strategies/` may import all of them. The orchestrator
`pipeline/run.ts` is the one place that crosses from `pipeline/` to
`strategies/` — via the `IngestStrategy` port, not a direct import.

## Invariants enforced here

- **One active strategy, factory-wired.** `createFlatFolderStrategy(deps)`
  builds the strategy; `createPipelineRunner({ strategy, sourceFactory? })`
  wraps it; the worker handlers are `(msg) => runner.run({ job, payload })`.
  Adding a strategy means a new factory and a new wiring line — never
  editing the worker. The archived `basic-file-analysis/` is `.archived`
  (not compiled).
- **Per-job LLM credentials flow payload → context → call site.** The
  runner (`pipeline/run.ts` for index, `pipeline/pull.ts` for pull) reads
  `{llmApiKey, llmProvider, llmModel}` from the payload, packs them into
  an `AskLlmOptions` bag stored on `StrategyContext.llmCallContext`, and
  every LLM-touching phase passes that bag into `askJsonLLM` /
  `askYesNoLLM`. OSS standalone leaves these unset and falls back to
  `Config.OpenrouterApiKey` + `Config.LlmProvider`.
- **State transitions are explicit and dual-written.** `pipeline/run.ts`
  transitions the knowledge state to `PROCESSING` before any work, `PROCESSED` on
  success, `FAILED` best-effort on uncaught errors. Each transition mirrors
  to Neo4j via `setKnowledgeStateInGraph`, swallowing Neo4j failures so a
  graph hiccup doesn't fail the job.
- **`CancellationError` is not `FAILED`.** A `throwIfCancelled` thrown
  inside the strategy propagates past `pipeline/run.ts`, which clears the
  in-process cancel flag and re-throws — the knowledge state stays at `PROCESSING`
  (clearable by re-running). Failed state is reserved for actual errors.
- **Disk is the inter-phase contract.** The flat-folder strategy writes
  `bigFiles.json`, `file-analysis/*.json`, `big-file-analysis/<encoded>.manifest.json`,
  `folder-summaries/*.json`, `repo-summary.json` between phases so a crash
  resumes from the next sub-phase boundary on the next run.
- **Per-file fallback never throws past the file.** LLM / parse / IO
  failures inside a file degrade to an empty analysis + WARN log; the batch
  continues. Whole-strategy errors propagate to the queue for retry semantics.
- **No env reads.** Every setting flows through `@bb/config`. Repo path
  through `pipeline/paths.ts.reposRoot()` → `getPlumblineHome()`.
- **Token redaction at error boundaries.** `GitCloneError` redacts URL
  userinfo. The git binary is invoked via `execFile` with no shell — no
  injection surface.
- **No outbound calls except OpenRouter.** `@bb/llm` is the single egress;
  every other dependency reads from / writes to local SQLite / Neo4j.

## Adding a strategy

1. Create `strategies/<name>/`.
2. Implement `IngestStrategy` from `types/strategy.ts` — return a factory
   `create<Name>Strategy(deps): IngestStrategy`.
3. Wire it from `index.ts` (swap the `createFlatFolderStrategy` call).
4. Add `strategies/<name>/README.md`.

## Adding a phase to flat-folder

1. Add a new file under `strategies/flat-folder/phases/` or
   `strategies/flat-folder/backfill/`.
2. Call `throwIfCancelled(knowledgeId)` at entry.
3. Read inputs from disk artifacts in `MetaPaths`; write outputs to disk
   before returning so a crash mid-phase is recoverable.
4. Hook the phase into `strategies/flat-folder/index.ts.execute()` in the
   correct ordinal position.
