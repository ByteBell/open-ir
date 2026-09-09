# `@bb/queue-core`

Provider-agnostic interfaces for the async job queue layer.

## Responsibilities

Defines the contract that every queue backend must implement. `@bb/queue-honker` (Honker over SQLite) is the only implementation shipped today. Contains no I/O — pure TypeScript interfaces and shared types.

## Public Interfaces

- `IQueueProvider` — composite provider: `connect`, `close`, `ping`, `enqueueRaw`, `registerWorker`, `removeKnowledgeJobs`, `listFailedJobs`.
- `NormalizedEnqueueOptions` — provider-level enqueue input (priority already resolved to `JobPriority`).
- `WorkerRegistrationOptions` — `{ concurrency? }` knob passed to `registerWorker`.
- `JobHandler<T extends JobType>` — typed `(JobMessage<PayloadFor<T>>) => Promise<void>`.
- `QueuePingResult` — `{ ok: boolean; latencyMs: number }`.
- `FailedJob` — normalized DLQ row shape returned by `listFailedJobs`.

## Data Ownership

None. This package owns no data — it only describes shapes.

## Tier

Strategy. Consumed by `@bb/queue` (facade) and implemented by `@bb/queue-honker`.

## Invariants

1. **`enqueueRaw` returns a stable string `jobId`.** Providers may use their own internal IDs (Honker integers stringified). The facade stores this on the knowledge doc as `queueJobId`.
2. **`registerWorker` is synchronous.** It schedules workers; it does not await their first claim. Workers are torn down by `close()`.
3. **`removeKnowledgeJobs` never throws on missing jobs.** Returns `{ removed: 0 }` if no live job is associated with the knowledgeId.
4. **`listFailedJobs` is read-only.** It does not move, retry, or remove rows.
