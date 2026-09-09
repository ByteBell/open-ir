// Honker-over-SQLite implementation of `IQueueProvider`. Registers itself
// as the "honker" provider at module load; the server picks it up via
// `import "@bb/queue-honker"` (side effect) + `connectQueue("honker")`.
//
// Single-process, single SQLite file at `Config.QueueDbPath`. No network.

import { open, type Database, type Job, type JsonValue, type Queue } from "@russellthehippo/honker-node";
import { JobType, type JobMessage, type PayloadFor } from "@bb/types";
import { QueueConnectError, QueueNotConnectedError } from "@bb/errors";
import { logger } from "@bb/logger";
import { defaultConcurrencyFor, registerQueueProvider } from "@bb/queue";
import type {
  FailedJob,
  IQueueProvider,
  JobHandler,
  NormalizedEnqueueOptions,
  QueuePingResult,
  RemoveKnowledgeJobsResult,
  WorkerRegistrationOptions,
} from "@bb/queue-core";
import { mapHonkerPriority } from "./priority.ts";
import { resolveQueueDbPath } from "./paths.ts";
import { normalizeFailed } from "./failed.ts";

// Visibility = how long Honker waits before reassigning a claimed-but-not-
// heartbeated job to another worker. 5 min is large enough that GC pauses
// don't trigger spurious reclaims; heartbeating every 60 s gives us two
// missed-heartbeat tolerance.
const VISIBILITY_S = 300;
const HEARTBEAT_EXTEND_S = 300;
const HEARTBEAT_MS = 60_000;
// Fixed 5s backoff. Without an explicit retry delay, a failed
// job would wait the full VISIBILITY_S (300s) before being re-claimed.
const RETRY_DELAY_S = 5;
const MAX_ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 30_000;

const ALL_JOB_TYPES: readonly JobType[] = [
  JobType.GithubIndex,
  JobType.GithubPull,
  JobType.LocalIngest,
  JobType.BusinessContextProcessing,
];

interface WorkerLoop {
  controller: AbortController;
  done: Promise<void>;
}

class HonkerQueueProvider implements IQueueProvider {
  private db: Database | null = null;
  private queues = new Map<JobType, Queue>();
  private workers: WorkerLoop[] = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  async connect(): Promise<void> {
    try {
      const dbPath = resolveQueueDbPath();
      // Honker auto-creates `_honker_live` / `_honker_dead` / etc. on first
      // open — no explicit `bootstrap()` call needed.
      const db = open(dbPath);
      // Honker defaults to WAL + busy_timeout=5000ms (verified in smoke
      // tests), but we re-assert defensively so a future Honker default
      // change can't silently regress concurrent-cancel safety.
      // `removeKnowledgeJobs` runs a DELETE inside `db.transaction()`;
      // without a busy_timeout, two simultaneous cancels would race and
      // one would throw SQLITE_BUSY.
      db.query("PRAGMA journal_mode=WAL", null);
      db.query("PRAGMA busy_timeout=5000", null);
      for (const type of ALL_JOB_TYPES) {
        this.queues.set(type, db.queue(type, { visibilityTimeoutS: VISIBILITY_S, maxAttempts: MAX_ATTEMPTS }));
      }
      this.db = db;
      // Periodic sweeper moves attempts-exhausted rows from `_honker_live`
      // to `_honker_dead`. `unref()` so it doesn't keep the event loop alive.
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref();
    } catch (cause: unknown) {
      this.queues.clear();
      this.db = null;
      throw new QueueConnectError(cause);
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // Abort all worker `claim()` iterators, then wait for their `for await`
    // loops to unwind before closing the database (so no read happens
    // against a closed handle).
    const loops = this.workers.splice(0);
    for (const w of loops) {
      w.controller.abort();
    }
    await Promise.allSettled(loops.map((w) => w.done));
    this.queues.clear();
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  async ping(): Promise<QueuePingResult> {
    const start = performance.now();
    try {
      this.requireDb().query("SELECT 1", null);
      return { ok: true, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { ok: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  async enqueueRaw<T extends JobType>(
    type: T,
    message: JobMessage<PayloadFor<T>>,
    opts: NormalizedEnqueueOptions,
  ): Promise<string> {
    const db = this.requireDb();
    const queue = this.requireQueue(type);
    // Honker has no native stable-jobId concept to dedupe on,
    // so we emulate it by querying `_honker_live` for an existing row with
    // matching knowledgeId. If found, return its id — re-publishing the
    // same logical job is a no-op (per the IQueueProvider contract).
    const existing = db.query(
      "SELECT id FROM _honker_live WHERE queue = ? AND json_extract(payload, '$.knowledgeId') = ? LIMIT 1",
      [type, message.knowledgeId],
    );
    const firstRow = existing[0];
    if (firstRow !== undefined) {
      return String(firstRow["id"]);
    }
    const id = queue.enqueue(message as unknown as JsonValue, {
      priority: mapHonkerPriority(opts.priority),
    });
    return String(id);
  }

  registerWorker<T extends JobType>(type: T, handler: JobHandler<T>, opts: WorkerRegistrationOptions = {}): void {
    const queue = this.requireQueue(type);
    const concurrency = opts.concurrency ?? defaultConcurrencyFor(type);
    // N independent loops with batch_size=1 each — prevents head-of-line
    // blocking from a slow job in the same claim batch. Gives the usual
    // `concurrency` semantics (N jobs in flight per type).
    for (let i = 0; i < concurrency; i++) {
      const workerId = `${type}-${i}-${process.pid}`;
      const controller = new AbortController();
      const done = this.runWorkerLoop(queue, workerId, handler, controller.signal);
      this.workers.push({ controller, done });
    }
  }

  private async runWorkerLoop<T extends JobType>(
    queue: Queue,
    workerId: string,
    handler: JobHandler<T>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      // `queue.claim()` is an AsyncIterableIterator that wakes on DB updates
      // or due deadlines (no polling). The signal lets `close()` end the
      // iterator cleanly.
      for await (const job of queue.claim(workerId, { signal })) {
        await this.processJob(job, workerId, handler);
      }
    } catch (err) {
      // Aborts during shutdown are expected — log only on real crashes.
      if (signal.aborted) {
        return;
      }
      logger.error(`queue-honker: worker=${workerId} loop crashed: ${describeError(err)}`);
    }
  }

  private async processJob<T extends JobType>(job: Job, workerId: string, handler: JobHandler<T>): Promise<void> {
    // Lease ownership tracking. If `heartbeat()` ever returns false the
    // visibility window expired (event loop stall, long sync work) and
    // another worker has reclaimed this job. Policy: stop-and-finish —
    // log it, stop heartbeating, let the handler complete normally.
    // Both workers' writes converge at the destination via idempotent
    // upserts; the cost is duplicate LLM tokens on the rare event.
    let ownsLease = true;
    const hb = setInterval(() => {
      if (!ownsLease) {
        return;
      }
      const ok = job.heartbeat(HEARTBEAT_EXTEND_S);
      if (!ok) {
        ownsLease = false;
        logger.warn(`queue-honker: worker=${workerId} job=${job.id} lost lease mid-flight; stop-and-finish`);
      }
    }, HEARTBEAT_MS);
    try {
      await handler(job.payload as unknown as JobMessage<PayloadFor<T>>);
      // Only ack if we still own the lease — otherwise the row already
      // belongs to another worker; double-acking is a no-op but it's
      // cleaner not to issue the write.
      if (ownsLease) {
        job.ack();
      }
    } catch (err: unknown) {
      const reason = describeError(err);
      logger.error(`queue-honker: job=${job.id} handler threw: ${reason}; scheduling retry`);
      // `retry(delayS, error)` increments `attempts` and re-queues with a
      // 5s delay. After MAX_ATTEMPTS exhaustions,
      // the next `sweepExpired()` tick moves the row to `_honker_dead`.
      if (ownsLease) {
        job.retry(RETRY_DELAY_S, reason);
      }
    } finally {
      clearInterval(hb);
    }
  }

  async removeKnowledgeJobs(knowledgeId: string): Promise<RemoveKnowledgeJobsResult> {
    const db = this.requireDb();
    const placeholders = ALL_JOB_TYPES.map(() => "?").join(",");
    // Best-effort delete across all queues by knowledgeId. Honker's Queue
    // API doesn't expose a `cancel` method — direct table mutation is the
    // documented escape hatch (per the user-supplied SQL reference).
    // Wrapped in a transaction so partial failures don't leave half-deleted
    // state visible to a concurrent claim.
    const tx = db.transaction();
    try {
      const removed = tx.execute(
        `DELETE FROM _honker_live WHERE queue IN (${placeholders}) AND json_extract(payload, '$.knowledgeId') = ?`,
        [...ALL_JOB_TYPES, knowledgeId],
      );
      tx.commit();
      return { removed };
    } catch (err) {
      try {
        tx.rollback();
      } catch {
        // already rolled back / commit failed — swallow
      }
      throw err;
    }
  }

  async listFailedJobs(): Promise<FailedJob[]> {
    const db = this.requireDb();
    const rows = db.query("SELECT id, queue, payload, attempts, last_error, died_at FROM _honker_dead", null);
    return rows.map(normalizeFailed);
  }

  /** Move attempts-exhausted rows from `_honker_live` to `_honker_dead`. */
  private sweep(): void {
    for (const queue of this.queues.values()) {
      try {
        queue.sweepExpired();
      } catch (err) {
        logger.warn(`queue-honker: sweepExpired threw: ${describeError(err)}`);
      }
    }
  }

  private requireDb(): Database {
    if (this.db === null) {
      throw new QueueNotConnectedError();
    }
    return this.db;
  }

  private requireQueue(type: JobType): Queue {
    const q = this.queues.get(type);
    if (q === undefined) {
      throw new QueueNotConnectedError();
    }
    return q;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

registerQueueProvider("honker", () => new HonkerQueueProvider());
