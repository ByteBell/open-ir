# `@bb/ingest-github/src/strategies/flat-folder/backfill`

Post-analysis top-up. After Phases 1 and 2 have produced
`CondensedFileAnalysis` JSON on disk, this phase sweeps the in-memory
cache to fill extended-analysis fields the main per-file prompt left
empty. Idempotent — entries that already look complete are skipped
without an LLM call.

The big-file backfill phase that used to live here was removed: the
new chunk-task-queue model in `phases/process-big-files.ts` handles
crash recovery directly via the per-chunk disk cache and `inspect()`,
and same-run condense failures are now retried twice in-place before
being marked failed.

## Files

- `fields.ts` — Phase 3. `backfillMissingFields(metaPaths, cache, limiter, llmCallContext?, progressContext?)`
  iterates every condensed entry from the shared `FileAnalysisCache`,
  computes which extended-analysis fields are missing (`keywords`,
  `ontologyConcepts`, `businessEntities`, `systemCapabilities`,
  `sideEffects`, `configDependencies`, `dataFlowDirection`,
  `integrationSurface`, `contractsProvided`, `contractsConsumed`,
  `sectionMap`), and dispatches one LLM call per file **through the shared
  `ConcurrencyLimiter`** to fill only the missing slots. Tasks run
  concurrently up to `Config.LlmConcurrency`; the loop builds the task
  array and awaits `Promise.all` at the end. The response is validated and
  normalised (`pickStringArray`, `pickSections`) before being written back
  via `saveCondensed` **and** mirrored into the cache via `cache.set(entry)`
  so downstream phases (folder summary, graph store) see the updated entry
  without re-reading disk. Entries with nothing missing are skipped
  without an LLM call. Progress reporter is fixed-total sized by
  `cache.size`. Emits `phase3 dispatching N backfill tasks` at entry so the
  caller can see how many tasks went through the limiter.

## Public interfaces

- `backfillMissingFields(metaPaths, cache, limiter, llmCallContext?, progressContext?): Promise<{ updated, failed }>`

Returns phase-summary counters consumed by `createFlatFolderStrategy`
to roll up into the strategy result.

## Data ownership

This phase owns no new on-disk artifacts. It mutates existing
condensed JSON in place via `saveCondensed` and mirrors the same
mutation into `FileAnalysisCache`.

## Invariants

- Idempotent: a second run is a no-op once every entry passes the
  completeness check.
- Per-file LLM failure is logged and counted, never thrown. The phase
  continues to the next entry. Only `LlmConfigError` / `LlmError`
  propagate (treated as job-fatal upstream).
- LLM output is untrusted: missing slots are filled only when the
  response yields a non-empty value of the expected shape; partial
  responses leave unfilled slots for a future pass.
- Cache and disk stay in lockstep — every `saveCondensed` is paired
  with a `cache.set(entry)` in the same code path.
- Concurrency is bounded by the shared `ConcurrencyLimiter` (today's
  `Config.LlmConcurrency`). Counters (`updated`, `failed`, token totals)
  are mutated from inside the concurrent tasks — safe under JS's
  single-threaded event loop, no locking needed.

## External dependencies

`@bb/llm` (`askJsonLLM`), `@bb/logger`, `@bb/db-core` (types only —
`FileAnalysis`, `FileAnalysisSection`), the sibling
`flat-folder/file-analysis-cache.ts`, and the prompts under
`flat-folder/prompts/backfill.ts`.

## Tier

Strategy (under the `flat-folder` domain strategy).
