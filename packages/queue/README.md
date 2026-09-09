# `@bb/queue` — context

## Tier

Strategy. May depend on Kernel (`@bb/types` for job enums + payloads,
`@bb/errors` for typed error classes) and Infrastructure (`@bb/config` for
concurrency settings, `@bb/db` for the knowledge-state transition on
enqueue). The concrete backend lives behind `@bb/queue-core`'s
`IQueueProvider` — today `@bb/queue-honker` (Honker over SQLite).
May be imported by Domain (`@bb/ingest-github` will register workers) and
Binaries (`@bb/server` will call publishers from HTTP routes). Never by
`@bb/cli`.

## Responsibility

The package owns:

- Provider lifecycle — `connectQueue(name)` selects and connects the
  registered `IQueueProvider`; `closeQueue()` tears it down
- The two GitHub publishers — `enqueueGithubIndex` and `enqueueGithubPull`
- Worker registration — `registerWorker(type, handler, opts?)`, delegated
  to the active provider
- The `JobMessage` envelope shape carried as the job payload
- Dedupe-key convention `${type}-${knowledgeId}`; per-provider priority
  mapping lives in the provider package
- The `status.state → QUEUED` write that accompanies a successful
  enqueue (delegated to `@bb/db.knowledgeDb.setKnowledgeState`)

The package does **not** own:

- Worker handler implementations (live in `@bb/ingest-*`)
- Knowledge-document creation, deletion, or any mutation other than the
  state transition on enqueue (`@bb/db`)
- Recovery / restart / orphan re-enqueue (deferred — see _Out of scope_)
- Progress reporting, status validation, batch processing, admin
  pause/resume/cancel (all out of scope for OSS v0)
- Outbound telemetry of job lifecycle events (out of scope; structured `@bb/logger` output is the only sink)

## Public exports

```ts
function connectQueue(): Promise<void>;
function closeQueue(): Promise<void>;

function enqueueGithubIndex(payload: GithubIndexPayload, opts?: EnqueueOptions): Promise<string>;
function enqueueGithubPull(payload: GithubPullPayload, opts?: EnqueueOptions): Promise<string>;

function registerWorker<T extends JobType>(type: T, handler: JobHandler<T>, opts?: WorkerRegistrationOptions): Worker;

interface EnqueueOptions {
  priority?: JobPriority;
}
interface WorkerRegistrationOptions {
  concurrency?: number;
}
type JobHandler<T extends JobType> = (msg: JobMessage<PayloadFor<T>>) => Promise<void>;
```

`_getQueue`, `_registerWorker`, `_isConnected`, `__resetForTests`,
`QUEUE_PREFIX`, `mapPriority`, `dedupeKey`, `buildJobMessage` are
**internal** — consumed only inside the package.

## Data ownership

The active provider handle and the registry of provider factories. No
knowledge of payload semantics beyond the type contract from
`@bb/types`. No document-store state is owned by this package — the
`status.state → QUEUED` write is a delegated call into `@bb/db`.

## Invariants

1. **Document-store write before the queue publish.** Each publisher calls
   `setKnowledgeState(_, QUEUED)` first, then enqueues. If the write
   succeeds and the enqueue fails, both operations are idempotent under
   retry (the provider dedupes by stable job id, `setKnowledgeState` is a
   same-value set). Reverse ordering would race the worker against a stale
   `CREATED` state.
2. **Connection is required.** Calling any publisher or `registerWorker`
   before `connectQueue()` throws `QueueNotConnectedError`. `closeQueue()`
   is graceful and re-entrant.
3. **One provider active at a time.** `connectQueue()` is a cold cutover;
   `closeQueue()` must run before re-connecting under another name.
4. **Workers close before queues.** `closeQueue()` awaits all worker
   `close()` first so they finish in-flight jobs before queues release
   their handles.
5. **Dedupe key is stable.** `${type}-${knowledgeId}` — re-publishing the
   same logical job is a no-op; both calls return the same `jobId` string.
6. **Priority is a fixed 3-level enum.** `Low` / `Normal` / `High`; each
   provider maps it onto its own ordering (see `@bb/queue-honker`).

## External dependencies

- `@bb/types`, `@bb/errors`, `@bb/config`, `@bb/queue-core`, `@bb/db` —
  workspace deps (all explicit in `package.json`). The queue runtime
  itself is the active provider's dependency, not this package's.

## What is intentionally out of scope (v0)

- Recovery / orphan re-enqueue on startup
- Progress reporting and node-status state machine
- Admin operations (pause / resume / cancel / inspect)
- Health monitor (covered by `pingDb` + `pingQueue` at the server)
- Bitbucket / PDF / Website / Custom-context publishers — OSS is
  GitHub-only
- `GITHUB_REINDEX_FILES` partial-reindex job type
- `Critical` priority level (3 levels are enough for v0)
- Pre-enqueue knowledge-state assertion (caller ensures the doc exists;
  unconditional state set is fine)
- LLM credentials in the job payload — workers read OpenRouter key/model
  from `~/.plumbline/config.json` at handler time
- `gitToken` encryption — stored in the queue payload in plaintext;
  acceptable for local single-tenant. Document at deployment time.

## How to extend

Adding a new GitHub job type (e.g. `GithubReindexFiles`):

1. Add the enum entry and payload interface in `@bb/types` `src/job.ts`,
   including a new branch in `PayloadFor`.
2. Add the type to `ALL_JOB_TYPES` in `src/manager.ts` so a `Queue` is
   constructed at boot.
3. Add a publisher (`src/github-reindex-files.ts`) following the
   `setKnowledgeState → queue.add` ordering invariant.
4. Update `defaultConcurrencyFor` in `src/workers.ts` if the type uses a
   different concurrency knob.
5. Re-export from `src/index.ts`. Update _Public exports_ in this file.

Adding a worker handler (in an ingest package):

1. Add `@bb/queue` to that package's `dependencies`.
2. Call `registerWorker(JobType.GithubIndex, async (msg) => { … })`
   during package bootstrap. The handler receives the typed
   `JobMessage<GithubIndexPayload>`.
3. The worker is auto-tracked; `closeQueue()` will close it on shutdown.
