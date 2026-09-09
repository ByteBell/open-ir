import type { GithubIndexPayload, GithubPullPayload } from "@bb/types";
import type { AskLlmOptions } from "@bb/llm";
import type { FileAnalysis } from "@bb/db-core";
import type { ConcurrencyLimiter } from "#src/pipeline/concurrency.ts";
import type { DiffResult } from "#src/pipeline/git-diff.ts";
import type { EffectiveIgnoreSets } from "#src/pipeline/skip-decisions/effective.ts";

export interface ScannedFile {
  kind: "file";
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  content: string;
}

export interface OversizedFile {
  kind: "oversized";
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

export type ScanEntry = ScannedFile | OversizedFile;

export interface AnalyzedFileResult {
  language: string;
  analysis: FileAnalysis;
  tokenUsage?: { inputTokens: number; outputTokens: number; costUsd: number } | undefined;
  /** Subset of `tokenUsage` served from the `@bb/llm` disk cache (no fresh spend). */
  cachedTokenUsage?: { inputTokens: number; outputTokens: number; costUsd: number } | undefined;
}

export interface FileAnalyzer {
  analyze(input: {
    relativePath: string;
    content: string;
    /**
     * Per-job LLM credential overrides. When set, passed to `askJsonLLM` so
     * the file analysis uses the caller-supplied credentials instead of
     * `Config.OpenrouterApiKey`. Absent in OSS standalone.
     */
    llmCallContext?: AskLlmOptions;
  }): Promise<AnalyzedFileResult>;
}

export interface PipelineSummary {
  filesAnalyzed: number;
  foldersSummarised: number;
  repoSummarised: boolean;
  graphNodesWritten: number;
  commitHash: string;
  tokenUsage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Subset of `tokenUsage` served from cache / resumed from disk (not billable). */
  cachedTokenUsage: { inputTokens: number; outputTokens: number; costUsd: number };
  /**
   * True when the pull resolved to a no-op: either the target equals the
   * current commit, or the diff between them is empty. Consumers carry the
   * base commit's stats forward instead of recording zeros. Absent on real runs.
   */
  noOp?: boolean;
  /** The previously-indexed commit this no-op was measured against. Set iff `noOp`. */
  baseCommit?: string;
}

export interface PipelineDeps {
  reposRootDir: string;
}

export interface ScanDeps {
  skipDecider?: SkipDecider;
  /**
   * Per-job LLM credential overrides forwarded to the skip-decider when it
   * invokes the LLM branch. Absent in OSS standalone runs.
   */
  llmCallContext?: AskLlmOptions;
  /**
   * Shared LLM-concurrency limiter. When set, `scanRepository` uses a
   * two-pass strategy: walk + cache-only decisions in pass 1, parallel
   * deduplicated LLM resolution under this limiter in pass 2, drain the
   * pending list in pass 3 (all cache-hits). When absent (e.g. legacy
   * `SourceFactory` consumers), scan falls back to inline-await per file.
   */
  limiter?: ConcurrencyLimiter;
  /**
   * Effective ignore sets (seed defaults overlaid with per-job overrides) used
   * for directory-walk pruning and path filtering. Absent → built-in defaults.
   */
  ignoreSets?: EffectiveIgnoreSets;
}

export interface SourceReader {
  /** Iterate every scannable file in the repo, yielding ScanEntry. */
  scan(deps?: ScanDeps): AsyncGenerator<ScanEntry>;

  /** Read a single file by repo-relative path. Used by the big-file phase. */
  readFile(relativePath: string): Promise<string>;

  /** The resolved HEAD commit hash. Populated by the time the reader is returned. */
  readonly commitHash: string;

  /**
   * The committed timestamp of `commitHash` (ISO-8601, e.g. from `git log -1 --format=%cI`).
   * Optional: disk-backed readers populate it when the caller supplies it; other readers leave
   * it `undefined`. Consumers that record a commit date should coalesce to `null`.
   */
  readonly commitDate?: string | null;

  /** A stable on-disk path for the cloned tree when the reader is disk-backed; `""` otherwise. */
  readonly localRepoDir: string;
}

export interface ArchiveSinkInput {
  knowledgeId: string;
  relativePath: string;
  content: string;
}

export interface ArchiveSink {
  /** Push a single file's content to an external store. Failures are non-fatal. */
  push(input: ArchiveSinkInput): Promise<void>;

  /**
   * Seed the current commit's snapshot from a parent commit (copy-forward) so the
   * new commit folder is a complete, independently-readable tree before changed
   * files are pushed over it. Optional — sinks that are not commit-namespaced omit
   * it. Failures are non-fatal.
   */
  forkFrom?(fromCommit: string): Promise<void>;

  /**
   * Remove a file from the current commit's snapshot — used for deleted and
   * renamed-away paths during a pull. Optional. Failures are non-fatal.
   */
  remove?(relativePath: string): Promise<void>;
}

export interface SourceFactoryInput {
  knowledgeId: string;
  payload: GithubIndexPayload;
  branch: string;
}

export interface SourceFactoryResult {
  source: SourceReader;
  commitHash: string;
  archiveSink?: ArchiveSink;
}

/**
 * Optional injection hook used by `registerGithubWorkers`. When provided, the
 * runner skips the default disk clone and uses the returned reader instead.
 * The hook is intentionally generic — it names a seam, not any specific
 * alternative implementation. See `docs/extension-points.md`.
 */
export type SourceFactory = (input: SourceFactoryInput) => Promise<SourceFactoryResult>;

export interface PullFactoryInput {
  knowledgeId: string;
  payload: GithubPullPayload;
  /** The commit currently anchored on the knowledge document. The factory diffs from here to `targetCommit`. */
  currentCommit: string;
  /** Branch the knowledge tracks. The factory resolves the target commit relative to this branch. */
  branch: string;
}

export interface PullFactoryResult {
  /** Reader pinned at the resolved target commit; used by every downstream phase for file I/O. */
  source: SourceReader;
  /** Files changed between `currentCommit` and the resolved target. Same shape as `git diff --name-status`. */
  diff: DiffResult;
  /** Resolved target commit hash. Either the payload's `targetCommitHash` or the branch HEAD chosen by the factory. */
  targetCommit: string;
  /** Optional non-fatal sink. When set, the strategy archives analysed content via `push` after each file. */
  archiveSink?: ArchiveSink;
}

/**
 * Optional injection hook used by `registerGithubWorkers` for pull jobs.
 * When provided, `runPull` skips `syncRepository` + `computePullDiff` +
 * `checkoutCommit` and uses the factory's reader + diff directly. The
 * open-source binary leaves this undefined and pull runs against a local
 * git clone via `node:child_process`.
 */
export type PullFactory = (input: PullFactoryInput) => Promise<PullFactoryResult>;

export type SkipDecision = "accept" | "reject-static" | "reject-llm" | "accept-llm";

export interface SkipDeciderInput {
  relativePath: string;
  absolutePath: string;
  ext: string;
  /** Pre-loaded content. When set, the LLM branch uses this instead of reading absolutePath from disk. */
  content?: string;
  /**
   * Per-job LLM credential overrides. When set and the decider invokes the
   * LLM branch, these credentials override `Config.OpenrouterApiKey`. Absent
   * in OSS standalone — the LLM branch falls back to the configured key.
   */
  llmCallContext?: AskLlmOptions;
}

export interface SkipDecider {
  /**
   * Single-shot decision: applies static filters, consults the in-memory
   * + on-disk caches, and falls through to the LLM when neither resolves
   * the decision. Persists the cache to disk after each LLM call.
   * Kept for non-scan callers and the legacy inline-await path.
   */
  decide(input: SkipDeciderInput): Promise<SkipDecision>;
  /**
   * Synchronous static-only decision. Returns the resolved `SkipDecision`
   * when static filters or cache hit resolves it; returns `null` to signal
   * "this needs an LLM call to resolve". Used by `scanRepository` in its
   * two-pass mode to collect pending entries without blocking the walk.
   */
  decideStatic(input: SkipDeciderInput): SkipDecision | null;
  /**
   * Asynchronous LLM-resolution path that **mutates the in-memory cache**
   * but does NOT persist to disk. The caller (typically `scanRepository`)
   * batches these under a `ConcurrencyLimiter` and then calls `persist()`
   * exactly once at the end of the batch, so concurrent `saveCache` calls
   * don't race on the tmp/rename atomicity.
   */
  decideAndDeferSave(input: SkipDeciderInput): Promise<SkipDecision>;
  /**
   * Persist the in-memory decision cache to disk. Best-effort: swallows
   * I/O errors. Called once at the end of a `decideAndDeferSave` batch.
   */
  persist(): void;
}
