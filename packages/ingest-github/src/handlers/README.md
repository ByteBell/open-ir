# `@bb/ingest-github/src/handlers`

Queue job entry shells. Pure boundary: narrow the payload, verify envelope
coherence, delegate to the pipeline runner. No I/O, no state transitions,
no clone — those belong in `pipeline/run.ts`.

## Files

- `ingest-job.ts` — `createGithubIngestHandler(deps)` and
  `createLocalIngestHandler(deps)` both return queue-shaped
  `(msg) => Promise<PipelineSummary>` callbacks (the summary carries
  per-commit `tokenUsage` including `costUsd` for downstream consumers
  that need to mirror it). `IngestJobHandlerDeps` accepts an optional
  `usageGuardFactory: (payload) => UsageGuard | undefined` — when set,
  the handler calls it once per job with the narrowed payload and
  forwards the returned guard to `runner.run({ ..., usageGuard })`. OSS
  standalone leaves the factory undefined and the pipeline runs without
  any quota enforcement. They throw `IngestError` on validation
  failures; everything else propagates to the queue as the worker's failure
  path.
- `README.md` — this file.

## Invariants

- Handlers do not touch the document store, Neo4j, the filesystem, or the LLM. They are
  pure validators that delegate to `IngestRunnerDeps.run`.
- Handlers are factory-built so the wiring in `index.ts` injects the runner
  the strategy is composed against. Tests can inject a mock runner.
