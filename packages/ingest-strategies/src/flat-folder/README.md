# `@bb/ingest-github/src/strategies/flat-folder`

The v2 ingestion strategy: scan + classify → analyse small + big in parallel →
field backfill → folder summary → repo summary → graph store. Each phase
persists artifacts on disk before the next begins, so a crash resumes cleanly
from the next sub-phase boundary.

The strategy constructs **one shared `ConcurrencyLimiter`** at entry (sized by
`Config.LlmConcurrency`, default 29). Every LLM call across small-file
analyses, big-file chunk analyses, per-file condense calls, the skip-decision
LLM gate (during scan), field backfill, and folder summaries checks out from
this single pool. One knob bounds total in-flight LLM concurrency.

## Phases

1. **scan-and-classify** (`phases/scan-and-classify.ts`) — walks
   `source.scan({ skipDecider, limiter })` once, tokenises each file, classifies
   as `small` / `big` / `oversized`, and writes
   `meta-output/scan-manifest.json` (canonical) plus the legacy
   `bigFiles.json` (for the pull-path consumers). Scan internally uses a
   **two-pass** strategy: walk + cache-only `decideStatic` first, then
   parallel-deduplicated LLM resolution for unknown extensions/filenames
   through the shared limiter, then drain.
   1b. **write-eligible-files** (`eligible-files.ts`) — between scan and the
   2a/2b parallel block, persists `.plumbline/eligible_files.json` (paths +
   parent folders for every `small`/`big` entry, plus the commit hash) to
   the source layer (local disk under `source.localRepoDir/.plumbline/` and/or
   the `archiveSink`). Read back by `@plumbline/knowledge-validation` to
   verify every file the analyzer was asked to process landed in Neo4j.
   Hard-fails if neither write target is available — an un-validatable
   knowledge is not a state we want.
   2a. **analyse-small** (`phases/analyse-small.ts`) — reads the manifest's
   `kind: "small"` entries, re-opens content, runs the LLM file-analyser
   per file under the shared limiter, writes `CondensedFileAnalysis` JSON.
   Also writes oversized stubs.
   2b. **analyse-big-files** (`phases/process-big-files.ts` —
   `analyseBigFiles`) — chunk-task queue across all big files. Every chunk
   is an independent task on the shared limiter; per-file condense is
   scheduled as soon as that file's last chunk lands (one in-place retry
   on transient condense failures). Runs **concurrently with 2a**.
2. **backfill-fields** (`backfill/fields.ts`) — for each cached condensed
   entry with missing extended fields (`keywords`, `sideEffects`,
   `dataFlowDirection`, `sectionMap`, …) dispatches one LLM call through
   the shared limiter to fill the gaps. Idempotent — no-op on a complete
   entry.
3. **summarise-folders** (`folder-summary.ts`) — groups condensed entries
   by direct parent folder. Small folders
   (`≤ Config.FolderSummaryBatchMaxFiles`, default 15) are batched up to
   `Config.FolderSummaryBatchSize` (default 10) per LLM call. Bigger
   folders take the individual single-folder path. Both flows run through
   the shared limiter.
4. **summarise-repo** (`repo-summary.ts`) — load folder summaries
   shallowest-first; one call if it fits `ContextWindowLimit`, batch +
   merge otherwise; persist `repo-summary.json` with the v2-flat envelope.
5. **store-flat-analysis** (`phases/store-flat-analysis.ts`) — ensure
   flat-folder indexes, upsert `:Repo`, then every `:Folder`, then every
   `:File` with the extended analysis + Folder→File `CONTAINS` edge.

## Progress events

The strategy emits progress through the `ProgressContext` port defined in
`src/progress/`. `createFlatFolderStrategy(deps)` accepts an optional
`progressContextFactory`; absent → `nullProgressContextFactory`
(no-op, OSS default).

- **Boundary events** are split between the runner and the strategy:
  - `phaseChanged("clone")` is emitted by `pipeline/run.ts` (the runner)
    before `syncRepository`, so the SSE stream stays alive during the
    network/disk-bound prelude.
  - `phaseChanged("scan")` is emitted by `index.ts` before phase 1.
  - `phaseChanged("file_analysis")` before the parallel 2a/2b block.
  - `phaseChanged("folder_analysis")` before phase 4 (folder summaries).
  - `phaseChanged("indexing")` before phase 5 (which feeds phase 6).
  - `completed()` after phase 6 returns.
  - `failed(message)` from a `try/catch` wrapping the whole `execute`.
- **Intra-phase ticks** are emitted via per-phase reporters created from
  `progressContext.reporter(...)`. Sub-phase labels:
  - phase 1 (scan) → no sub-phase, growing total (driven by `incrementSeen`).
  - phase 2a (analyse-small) → `analyse_small`, fixed total =
    `smallCount + oversizedCount`.
  - phase 2b (analyse-big) → two reporters: `big_files_chunks` (fixed total
    = sum of estimated chunks across all big files) and `big_files_condense`
    (fixed total = `bigCount`).
  - phase 3 → `backfill`, fixed total = `cache.size`.
  - phase 4 → no sub-phase, fixed total = directly-grouped folder count.
  - phase 6 → `folders` (growing) then `files` (fixed total = `cache.size`).
- **Pull-path-only sub-phases** (emitted by `pipeline/pull.ts` workflow,
  not the main strategy): `big_files_queue` (legacy single-file driver),
  `big_file:<relativePath>` (per-big-file chunk pulses inside the legacy
  driver), `pull` (`analyse-changed.ts` selective file analysis).
- **Total mode**: scan is the only main-strategy phase that uses
  `growing` mode. Everything else has fixed totals known up front from the
  scan manifest, the file-analysis cache, or the folder grouping.
- The cancellation path in `execute` lets `CancellationError` propagate
  past the orchestrator; `failed()` only fires for non-cancellation
  errors.

## Files

- `index.ts` — `createFlatFolderStrategy(deps)` orchestrates the phases.
  Accepts `{ fileAnalyzer, progressContextFactory? }`. Constructs one
  `ProgressContext` per job AND one shared `ConcurrencyLimiter` per job
  (sized by `Config.LlmConcurrency`); threads both into every phase that
  needs them.
- `types.ts` — `AnalyzedFileEntry`, `FolderSummary`, `RepoSummary`,
  `RepoSummaryEnvelope`, `FlatFolderResult`.
- `analyse-file.ts` — `analyseScannedFile(analyzer, file, llmCallContext?)` + `buildOversizedStub`.
- `analyse-changed.ts` — `analyseChangedFiles({knowledgeId, source, metaPaths, analyzer, diff, ignoreSets, llmCallContext?, archiveSink?, progressContext?})`. Pull-time per-file dispatcher. Reads changed file content through `input.source` (a `SourceReader`) so it works with both the disk-backed reader (OSS default) and any HTTP-backed alternative supplied via the `pullFactory` hook. Mirrors `analyseSmallFiles`'s per-file path: static-ignore check → fetch → size cap → binary detect → line count → analyse → save + archive push. Does NOT invoke the skip-decision LLM gate. `ignoreSets` (per-job effective ignore sets, see `pipeline/skip-decisions/effective.ts`) is **required** — callers with no overrides pass `buildEffectiveIgnoreSets()`; there is deliberately no filename/extension-only fallback, because walk-time pruning never runs on diff paths and a fallback would silently drop the directory + glob checks (the index-vs-pull divergence this exists to close). When `progressContext` is present it creates a fixed-total reporter (`subPhase: "pull"`, `total = dedupedPaths.length`) and increments per-path so the pull SSE stream stays live.
- `analyse-changed-helpers.ts` — `isStaticallyIgnored` (index-equivalent static skip decision for one diff path; `sets` required, no fallback), `mergeBigFileEntries`, `describe`. Split out of `analyse-changed.ts` to keep it under the 300-line ceiling.
- `file-analysis-cache.ts` — in-memory `Map<relativePath, CondensedFileAnalysis>`
  loaded once between phase 2 and phase 3; shared read-only by phases 3, 4,
  6; mutated by phase 3 backfill via `cache.set(entry)` so downstream phases
  see updated entries without re-reading disk.
- `scan-manifest.ts` — `ScanManifest` shape, `readScanManifest`,
  `writeScanManifest`. The canonical handoff between phase 1 and phases 2a/2b.
- `eligible-files.ts` — `writeEligibleFiles({knowledgeId, manifest, source, archiveSink?})`. Writes `.plumbline/eligible_files.json` to the source layer between phase 1 and 2a/2b. The validation service (`@plumbline/knowledge-validation`) reads this artifact to cross-check post-indexing consistency.
- `folder-path.ts` — `directFolderOf`, `affectedFolderPaths`.
- `folder-summary.ts` — group + summarise (individual or batched) + persist
  - iterate folder summaries; shared `dispatchFolderSummaries` used by both
    the main strategy and the pull-path's selective folder phase.
- `folder-summary-selective.ts` — pull-time selective folder summary phase.
- `repo-summary.ts` — single-shot or batched repo summary with envelope writer.
- `phases/scan-and-classify.ts` — Phase 1.
- `phases/analyse-small.ts` — Phase 2a.
- `phases/process-big-files.ts` — Phase 2b (`analyseBigFiles`, chunk-task
  queue) plus the legacy `processBigFilesQueue` driver used by the pull-path.
- `phases/store-flat-analysis.ts` — Phase 6.
- `backfill/fields.ts` — Phase 3 (parallel via shared limiter).
- `big-file/` — chunker, analyzer, condenser, storage, cache used by both
  big-file drivers.
- `prompts/` — LLM prompts shared across the phases.

## Invariants

- Disk is the inter-phase contract. No phase keeps state in memory past its
  end-of-phase write.
- LLM failures fall back to empty analyses or deterministic merges; the
  strategy never aborts on a per-file LLM error.
- `throwIfCancelled(knowledgeId)` runs at every phase boundary and between
  big-file chunks. A cancellation re-throws past the strategy boundary so
  the orchestrator clears the cancel flag without setting FAILED state.
- **All file content access goes through `input.source` (a `SourceReader`).**
  No phase calls `fs.readFile`, `path.join(repoDir, …)`, or
  `scanRepository(rootDir)` directly. This keeps the strategy decoupled
  from any specific reader implementation; any caller that supplies an
  alternative reader through the `sourceFactory` hook (see
  `docs/extension-points.md`) gets the same seven-phase pipeline unchanged.
- **Archive push is best-effort.** Phase 1 calls `input.archiveSink?.push`
  after `saveCondensed`; failures inside the sink are logged WARN and do
  not interrupt the analyse loop. The open-source binary never wires a
  sink — `archiveSink` is undefined and the call is skipped entirely.
- **Per-call LLM credentials thread through every phase.** The orchestrator
  reads `context.llmCallContext` (an optional `AskLlmOptions` built by
  the runner from `GithubIndexPayload.{llmApiKey, llmProvider, llmModel}`)
  and forwards it into every phase that issues LLM calls: phase 1 via
  `scanAndClassify` (forwarded into `source.scan({ llmCallContext })` for
  the skip-decision LLM gate), phase 2a via `analyseSmallFiles`, phase 2b
  via `analyseBigFiles` (which threads it into **both** the chunk analyzer
  and `condenseChunks`), phase 3 via `backfillMissingFields`, phase 4 via
  `runFolderSummaryPhase`, phase 5 via `summariseRepo`. The phases pass
  the same option object through to `askJsonLLM` so the per-call override
  reaches `@bb/llm` unchanged. When `llmCallContext` is undefined the call
  falls back to `Config.OpenrouterApiKey` + `Config.LlmProvider`.
- **Optional usage-guard hook.** `StrategyInput.usageGuard` (from
  `@bb/types`) is destructured at the top of `execute`. When present, the
  orchestrator awaits `usageGuard.onPhaseComplete(phase, cumulative)` after
  every token-consuming phase — `file_analysis` (post small + big),
  `folder_analysis` (post phase 5), and `repo_summary` (post phase 6) —
  with the cumulative `{ inputTokens, outputTokens, costUsd }` aggregated
  so far. The guard may throw `UsageLimitExceededError` to abort the run;
  the throw bubbles up to `pipeline/run.ts`, where the catch path calls
  `flushPartial(cumulative)` once and persists FAILED with category
  `usage_limit_exceeded`. When `usageGuard` is undefined (OSS default)
  every call short-circuits via `await usageGuard?.…` and the strategy
  runs identically to today.
