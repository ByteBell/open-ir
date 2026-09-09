# `@bb/queue/src` — context

Implementation of `@bb/queue`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

## Files

- **[index.ts](index.ts)** — public re-exports. The only entry point other
  packages may import. Anything not re-exported here is internal.
- **[registry.ts](registry.ts)** — the provider registry and facade core.
  `registerQueueProvider(name, factory)` (called by a provider package at
  import time), `connectQueue(name)` / `closeQueue()` / `pingQueue()`, and
  the internal `getQueue()` accessor, which throws
  `QueueNotConnectedError` before connect.
- **[envelope.ts](envelope.ts)** — pure helper: `buildJobMessage(type,
priority, payload)` constructs the `JobMessage<P>` envelope (UUID v4 id,
  `attempt: 0`, ISO timestamp).
- **[concurrency.ts](concurrency.ts)** — `defaultConcurrencyFor(type)`,
  reading `Config.ConcurrencyGithub` for GitHub job types.
- **[github-index.ts](github-index.ts)** — `enqueueGithubIndex` publisher.
  Document-store write first (`setKnowledgeState(_, QUEUED)`), then the
  provider enqueue. Also exports `EnqueueOptions` (shared with the others).
- **[github-pull.ts](github-pull.ts)** — `enqueueGithubPull` publisher.
  Same ordering and structure as the index publisher.
- **[local-ingest.ts](local-ingest.ts)** — `enqueueLocalIngest` publisher.
- **[workers.ts](workers.ts)** — `registerWorker(type, handler, opts?)`,
  delegated to the active provider.
- **[cancel.ts](cancel.ts)** — `removeKnowledgeJobs(knowledgeId)`.
- **[failed.ts](failed.ts)** — `listFailedJobs()` over the dead-letter set.
- **[resumer.ts](resumer.ts)** — `resumeOrphans()`, re-enqueuing knowledge
  docs left in `QUEUED` at boot.

## Module dependency graph

```
registry.ts     → @bb/errors, @bb/queue-core
envelope.ts     → @bb/types
concurrency.ts  → @bb/types, @bb/config
github-index.ts → registry.ts, envelope.ts, @bb/types, @bb/db
github-pull.ts  → registry.ts, envelope.ts, github-index.ts (EnqueueOptions),
                  @bb/types, @bb/db
local-ingest.ts → registry.ts, envelope.ts, github-index.ts (EnqueueOptions), @bb/types
workers.ts      → registry.ts, @bb/types, @bb/queue-core
cancel.ts       → registry.ts, @bb/queue-core
failed.ts       → registry.ts, @bb/queue-core
resumer.ts      → github-index.ts, @bb/types, @bb/db, @bb/logger
index.ts        → re-exports the public surface
```

No cycles. `registry.ts`, `envelope.ts` and `concurrency.ts` are leaves
within the package (no intra-package imports). Publishers depend on
`registry.ts` + `envelope.ts`; `workers.ts`, `cancel.ts` and `failed.ts`
depend only on `registry.ts`.

## Invariants enforced here

- **One provider active at a time.** `connectQueue()` is a cold cutover;
  `closeQueue()` must run before re-connecting under another name.
- **Close is graceful and ordered.** The provider's `close()` finishes
  in-flight handlers before releasing its queue handles.
- **Document-store write before the enqueue.** Every publisher does
  `setKnowledgeState(_, QUEUED)` then enqueues. The ordering is
  load-bearing — see [../README.md](../README.md) _Invariants_.
- **No raw provider leak.** Consumers in higher tiers see only the typed
  publisher signatures; new publishers live in this folder and use
  `getQueue()`.
- **No env reads.** All settings come from `@bb/config`. A repo-wide
  ESLint rule blocks `process.env`.
- **Errors carry typed metadata.** Construction sites use the catalog in
  `@bb/errors` — never inline `new Error(string)`. `QueueConnectError`
  carries the underlying `cause`; `QueueNotConnectedError` is a marker.

## Adding a publisher / worker

Follow the recipes in [../README.md](../README.md) under _How to extend_.
New publishers live as flat files in `src/<job>.ts` (no subdirectories —
the repo's ESLint rule forbids parent traversal). Compose `_getQueue`,
`buildJobMessage`, `mapPriority`, `dedupeKey`, and `setKnowledgeState`.
