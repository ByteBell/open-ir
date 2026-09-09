# `@bb/queue-honker/src` — context

Implementation of the Honker-over-SQLite provider that registers itself with `@bb/queue` as `"honker"`. See [../README.md](../README.md) for the package-level contract.

## Files

- **[index.ts](index.ts)** — single side-effect import of `./provider.ts`. Importing the package as `import "@bb/queue-honker"` triggers provider registration.
- **[provider.ts](provider.ts)** — `HonkerQueueProvider` class implementing `IQueueProvider`. Owns the `Database` handle, the `Map<JobType, Queue>`, the per-loop `AbortController[]` for worker shutdown, and the sweeper timer. Registered as `"honker"` via `registerQueueProvider` at module load.
- **[priority.ts](priority.ts)** — `mapHonkerPriority(JobPriority)` returns Honker's higher-number-wins numeric priority (Low=1, Normal=100, High=1000).
- **[paths.ts](paths.ts)** — `resolveQueueDbPath()` returns `Config.QueueDbPath` (with `~/...` expanded to the home dir) if set, else `path.join(getPlumblineHome(), "queue.db")`.
- **[failed.ts](failed.ts)** — `normalizeFailed(row)` converts a raw `_honker_dead` row into the cross-provider `FailedJob` shape from `@bb/queue-core` (parses the TEXT JSON payload, extracts `knowledgeId`, converts `died_at` Unix seconds → ISO).

## Module dependency graph

```
priority.ts → @bb/types
paths.ts    → @bb/config, @bb/types, node:path, node:os
failed.ts   → @bb/types, @bb/queue-core
provider.ts → @russellthehippo/honker-node, @bb/types, @bb/config, @bb/errors,
              @bb/logger, @bb/queue (registerQueueProvider, defaultConcurrencyFor),
              @bb/queue-core, priority.ts, paths.ts, failed.ts
index.ts    → provider.ts (side effect only)
```

No cycles. `priority.ts`, `paths.ts`, `failed.ts` are leaves within the package.

## Internal table access

Honker exposes a typed API for the common operations (`Queue.enqueue` / `claim` / `ackBatch` / `sweepExpired`, `Job.heartbeat` / `retry`). For dedupe and cancellation it has no direct method, so we read/write the underlying tables directly:

- **Dedupe** (`enqueueRaw`):
  ```sql
  SELECT id FROM _honker_live
  WHERE queue = ? AND json_extract(payload, '$.knowledgeId') = ?
  LIMIT 1;
  ```
- **Cancel** (`removeKnowledgeJobs`):
  ```sql
  DELETE FROM _honker_live
  WHERE queue IN (?,?,?,?) AND json_extract(payload, '$.knowledgeId') = ?;
  ```
- **DLQ inspection** (`listFailedJobs`):
  ```sql
  SELECT id, queue, payload, attempts, last_error, died_at
  FROM _honker_dead;
  ```

The `_honker_live` schema (verified at smoke test): `id`, `queue`, `payload` (TEXT JSON), `state`, `priority`, `run_at`, `worker_id`, `claim_expires_at`, `attempts`, `max_attempts`, `created_at`, `expires_at`.

The `_honker_dead` schema: `id`, `queue`, `payload` (TEXT JSON), `priority`, `run_at`, `attempts`, `max_attempts`, `last_error`, `created_at`, `died_at`.
