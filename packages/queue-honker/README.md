# `@bb/queue-honker`

Honker-over-SQLite implementation of `@bb/queue-core`'s `IQueueProvider`.

## Tier

Strategy. Registers itself with `@bb/queue` via side-effect import as the `"honker"` provider.

## Responsibilities

- Implements `IQueueProvider` by wrapping `@russellthehippo/honker-node` (Honker SQLite extension).
- Owns the queue.db lifecycle: `connect()` opens the file and constructs `Queue` handles per `JobType`; `close()` aborts worker loops and closes the database.
- Maps `JobPriority` (Low / Normal / High) to Honker's higher-number-wins ordering (1 / 100 / 1000).
- Provides stable-jobId dedupe by querying `_honker_live` for an existing row whose payload's `knowledgeId` matches.
- Cancels knowledge jobs by deleting matching rows from `_honker_live` in a transaction.
- Runs a 30 s sweeper that calls `queue.sweepExpired()` per `JobType` to move retry-exhausted jobs into `_honker_dead`.

## Public exports

```ts
// Registers "honker" provider via side effect; no runtime exports.
import "@bb/queue-honker";
```

## Configuration

- `Config.QueueDbPath` — path to the SQLite file. Defaults to `path.join(getPlumblineHome(), "queue.db")` at boot. Set with `plumbline set queue-db <path>`.
- `Config.ConcurrencyGithub` (shared with all providers) — number of parallel worker loops per `JobType`.

## Worker loop

- **N parallel async loops per `JobType`**, each with its own `workerId`. Each iterates `queue.claim(workerId, { signal })` (an `AsyncIterableIterator<Job>`) so there's no head-of-line blocking from a slow job in the same batch.
- **Heartbeat:** `setInterval(60 s)` calling `job.heartbeat(300)` to extend the visibility window. Returns `false` if the lease was reclaimed by another worker.
- **Lease-loss policy:** stop-and-finish. Worker logs `lost lease mid-flight; stop-and-finish` and lets the handler complete. The other worker has already taken over; idempotent writes converge at the destination. No `AbortController` plumbing through the handler is required.
- **Handler throws:** worker calls `job.retry(5, errorMessage)` — Honker re-queues the row with a 5 s delay and increments `attempts`. After `maxAttempts=3` exhaustions, the next `sweepExpired()` moves the row into `_honker_dead`.

## Invariants

1. **One `Queue` handle per `JobType` at `connect()`.** Four queues (`GithubIndex`, `GithubPull`, `LocalIngest`, `BusinessContextProcessing`).
2. **Re-publishing the same `knowledgeId` is a no-op.** `enqueueRaw` checks `_honker_live` first; if a live row exists for that `(queue, knowledgeId)` pair, its id is returned unchanged.
3. **Cancellation is best-effort.** `removeKnowledgeJobs` deletes matching `_honker_live` rows in a transaction. If a worker holds a row in `processing`, the delete still succeeds but the handler completes; idempotent writes mean the cancellation only avoids _future_ work.
4. **WAL mode + busy_timeout** are set by `open()`/Honker defaults; we don't override.
5. **`close()` aborts before draining.** Sweeper interval cleared, every worker loop's `AbortController` aborted, all loop promises awaited, then `db.close()`.
6. **No env reads.** Path comes via `getConfigValue(Config.QueueDbPath)`.

## External dependencies

- `@russellthehippo/honker-node` — Honker Node binding (ships a NAPI native binary per platform; auto-resolved for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`).
- `@bb/queue-core` (interface), `@bb/queue` (registry + `defaultConcurrencyFor`), `@bb/types`, `@bb/config`, `@bb/errors`, `@bb/logger`.

## What is intentionally out of scope

- Cross-provider job migration. Switching `Config.QueueProvider` requires a cold cutover; the `@bb/queue` Orphan Resumer re-enqueues `state === QUEUED` knowledge docs at boot.
- Explicit `_honker_dead` purge — exposed via the facade's `listFailedJobs()` for inspection only.
- AbortSignal threading through handlers — see _lease-loss policy_ above.
