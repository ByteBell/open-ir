# `@bb/queue-core/src`

Provider-agnostic interfaces and shared types for the async job queue layer.

## Files

- **index.ts** — public interfaces (`IQueueProvider`, `JobHandler<T>`) and shared types (`NormalizedEnqueueOptions`, `WorkerRegistrationOptions`, `QueuePingResult`, `FailedJob`, `RemoveKnowledgeJobsResult`). No implementation — every concrete provider (`@bb/queue-honker`, …) implements `IQueueProvider`.
