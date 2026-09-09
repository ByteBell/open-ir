# `@bb/ingest-github/src/types`

Type-only barrel for the flat-folder ingestion package. No runtime code beyond
`emptyFileAnalysis()` and the `FALLBACK_LANGUAGE` constant.

## Tier

Domain (sub-folder of `@bb/ingest-github`).

## Files

- `strategy.ts` — `IngestStrategy`, `StrategyInput`, `StrategyResult`,
  `StrategyContext`. The strategy port the orchestrator dispatches to.
  `StrategyContext` carries `{ knowledgeId, orgId, repoId,
llmCallContext? }`; `llmCallContext` is the optional `AskLlmOptions`
  bag the runner builds from the job payload's LLM overrides and that
  each phase forwards into its `askJsonLLM` / `askYesNoLLM` calls. Absent
  in OSS standalone runs — calls fall back to `Config.OpenrouterApiKey`.
  `StrategyInput` also carries an optional `usageGuard?: UsageGuard`
  (from `@bb/types`): when present, the strategy invokes its
  `onPhaseComplete(phase, cumulative)` hook after every token-consuming
  phase so the implementation can throw `UsageLimitExceededError` to
  abort the run. OSS standalone leaves this undefined and behavior is
  unchanged.
- `pipeline.ts` — `ScannedFile`, `OversizedFile`, `ScanEntry`, `FileAnalyzer`
  port, `AnalyzedFileResult`, `PipelineDeps`, `PipelineSummary`,
  `SkipDecider` / `SkipDeciderInput` / `SkipDecision` (the unknown-extension
  gate port; implementation lives under `pipeline/skip-decisions/`). The
  `SkipDecider` interface exposes four methods: `decide` (legacy async
  single-shot), `decideStatic` (synchronous; returns the resolved decision
  or `null` to signal "needs an LLM call"), `decideAndDeferSave` (async LLM
  call that mutates the in-memory cache without flushing to disk), and
  `persist` (one-shot cache flush). The two-pass scan in `scan.ts` uses the
  latter three so unknown-extension probes fan out under the shared LLM
  limiter and the disk cache is written exactly once at the end of the
  batch.
  `SourceReader` / `ScanDeps` (the repository-read abstraction; default
  implementation in `pipeline/disk-source-reader.ts`). `ScanDeps.limiter`
  is the optional shared `ConcurrencyLimiter`; when supplied together with
  `skipDecider`, `scanRepository` switches to its two-pass strategy
  instead of the legacy inline-await walk.
  `ArchiveSink` /
  `ArchiveSinkInput` (an optional non-fatal sink that the open-source
  binary never calls), `SourceFactory` / `SourceFactoryInput` /
  `SourceFactoryResult` (the optional index-side injection hook surfaced
  through `registerGithubWorkers`), and `PullFactory` / `PullFactoryInput`
  / `PullFactoryResult` (the analogous pull-side injection hook).
  `FileAnalyzer.analyze()`, `SkipDeciderInput`, and `ScanDeps` each accept
  an optional `llmCallContext?: AskLlmOptions` so per-job credentials
  flow from `StrategyContext` into every LLM call site without breaking
  the OSS standalone (defaults to undefined → config-driven). Both
  factories are documented in `docs/extension-points.md`. The two are
  separate because pull additionally needs a `diff` and a resolved
  `targetCommit`, which index doesn't.
- `meta-paths.ts` — `MetaPaths` shape — the per-commit `repositoryDir` +
  `metaOutputRoot` siblings under
  `~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/`,
  plus the named leaf paths (`fileAnalysisDir`, `folderSummariesDir`, …)
  computed under `metaOutputRoot`. `metaRoot` is preserved as a
  back-compat alias for `metaOutputRoot`.
- `file-analysis.ts` — `FALLBACK_LANGUAGE = "unknown"` and `emptyFileAnalysis()`
  factory. Both consumed by the LLM adapter and the big-file condenser.
- `condensed-file-analysis.ts` — `CondensedFileAnalysis` is the on-disk record
  written under `<metaPaths.fileAnalysisDir>/<encodedPath>.json` after Phase 1
  and Phase 2; the inter-phase contract that lets Phase 3+ resume after a crash.
- `big-file.ts` — `BigFileEntry`, `BigFileReason`, `FileChunk`,
  `ChunkAnalysisResult`, `HugeFileManifest`. The shapes used by `bigFiles.json`
  and the chunk/manifest cache under `<metaPaths.bigFileAnalysisDir>`.
- `ingest-runner.ts` — `IngestRunnerDeps` shape the orchestrator + handler share, plus `IngestRunnerInput` which carries the per-job `{ job, payload }` and an optional `usageGuard?: UsageGuard` (from `@bb/types`) forwarded into the strategy.
- `index.ts` — barrel.

## Invariants

- Only types live here, with the single exception of `emptyFileAnalysis()` and
  `FALLBACK_LANGUAGE` which are zero-cost constants/factories.
- No file in this folder may import from `pipeline/`, `strategies/`, or
  `adapters/` — the tier flow is one-way from types outward.
