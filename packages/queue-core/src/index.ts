// Pure-interface package: defines the contract every queue substrate must
// satisfy (Honker-over-SQLite today; anything else tomorrow). No implementation lives here — `@bb/queue` is the facade that
// holds the registry; the actual providers are sibling packages that register
// themselves at module load via `registerQueueProvider`.

import type { JobMessage, JobPriority, JobType, PayloadFor } from "@bb/types";

/** What the facade hands to a provider after resolving caller defaults. */
export interface NormalizedEnqueueOptions {
  priority: JobPriority;
}

export interface WorkerRegistrationOptions {
  /** Override `Config.ConcurrencyGithub`. Today no caller does. */
  concurrency?: number;
}

export type JobHandler<T extends JobType> = (msg: JobMessage<PayloadFor<T>>) => Promise<void>;

export interface QueuePingResult {
  ok: boolean;
  latencyMs: number;
}

/** Cross-provider DLQ row. Providers normalise their native failed-job shape into this. */
export interface FailedJob {
  id: string;
  type: JobType;
  knowledgeId: string;
  attempts: number;
  failedAt: string;
  reason: string;
  payload: unknown;
}

export interface RemoveKnowledgeJobsResult {
  removed: number;
}

/**
 * The contract every queue substrate implements.
 *
 * Lifecycle: `connect()` → … work … → `close()`. The facade owns the
 * single-active-provider state; providers stay stateless across reconnects.
 *
 * Semantics every provider must preserve:
 *  - At-least-once delivery.
 *  - Idempotent re-publish for the same `knowledgeId` — `enqueueRaw` returns
 *    the existing job's id if one is already live.
 *  - Graceful close — workers finish in-flight jobs before connections drop.
 */
export interface IQueueProvider {
  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<QueuePingResult>;

  /**
   * Provider-level enqueue. The facade has already built the `JobMessage`
   * envelope and written `KnowledgeState.Queued` to `@bb/db`; the provider
   * just needs to make the job durable and return its id.
   *
   * The returned id is opaque to the facade but must be stable across
   * re-publishes of the same `(type, knowledgeId)` so cancellation works.
   */
  enqueueRaw<T extends JobType>(
    type: T,
    message: JobMessage<PayloadFor<T>>,
    opts: NormalizedEnqueueOptions,
  ): Promise<string>;

  registerWorker<T extends JobType>(type: T, handler: JobHandler<T>, opts?: WorkerRegistrationOptions): void;

  /** Best-effort cancellation. Active/processing jobs are left to finish. */
  removeKnowledgeJobs(knowledgeId: string): Promise<RemoveKnowledgeJobsResult>;

  listFailedJobs(): Promise<FailedJob[]>;
}
