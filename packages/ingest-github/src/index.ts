import path from "node:path";
import { JobType } from "@bb/types";
import { getPlumblineHome } from "@bb/config";
import { registerWorker } from "@bb/queue";
import type { IngestStrategy, PullFactory, PullRunner, SourceFactory, ProgressContextFactory } from "@bb/ingest-core";
import { dbProgressContextFactory, orgsRoot } from "@bb/ingest-core";
import { createPipelineRunner } from "./pipeline/run.ts";
import { createGithubIngestHandler, createLocalIngestHandler } from "./handlers/ingest-job.ts";

/**
 * Dependencies for the GitHub workers. The composition root resolves the
 * active `strategy` (e.g. via `@bb/ingest-strategies`' `pickStrategy`) and the
 * `pullRunner` (a flat-folder pull driver bound to this package's
 * `resolvePullSource`), then injects them here — `@bb/ingest-github` never
 * imports a strategy. The optional source/pull factories are documented in
 * `docs/extension-points.md`; the OSS binary leaves them undefined and uses the
 * default disk-backed readers.
 */
export interface RegisterGithubWorkersDeps {
  strategy: IngestStrategy;
  pullRunner: PullRunner;
  sourceFactory?: SourceFactory;
  pullFactory?: PullFactory;
  progressContextFactory?: ProgressContextFactory;
}

function buildRunner(
  strategy: IngestStrategy,
  sourceFactory: SourceFactory | undefined,
  progressContextFactory: ProgressContextFactory,
): ReturnType<typeof createPipelineRunner> {
  const runnerDeps: Parameters<typeof createPipelineRunner>[0] = {
    reposRootDir: orgsRoot(),
    strategy,
    progressContextFactory,
  };
  if (sourceFactory !== undefined) {
    runnerDeps.sourceFactory = sourceFactory;
  }
  return createPipelineRunner(runnerDeps);
}

export function registerGithubWorkers(deps: RegisterGithubWorkersDeps): void {
  const progressContextFactory = deps.progressContextFactory ?? dbProgressContextFactory;
  const runner = buildRunner(deps.strategy, deps.sourceFactory, progressContextFactory);
  // `registerWorker` expects `Promise<void>`; the handler returns
  // `Promise<PipelineSummary>` so the enterprise queue bridge can mirror
  // per-commit tokens + cost into the knowledge record. The OSS in-process
  // worker discards the summary.
  const indexHandler = createGithubIngestHandler({ runner });
  registerWorker(JobType.GithubIndex, async (msg) => {
    await indexHandler(msg);
  });
  const { pullRunner, pullFactory } = deps;
  registerWorker(JobType.GithubPull, async (msg) => {
    await pullRunner(msg, pullFactory, progressContextFactory);
  });
}

export function registerLocalIngestWorker(strategy: IngestStrategy): void {
  const runner = buildRunner(strategy, undefined, dbProgressContextFactory);
  const localHandler = createLocalIngestHandler({ runner });
  registerWorker(JobType.LocalIngest, async (msg) => {
    await localHandler(msg);
  });
}

/**
 * Compatibility shim — the legacy `<plumblineHome>/repos/` directory still
 * hosts the LLM-decision cache (`repos/llmdecisions/`) and the
 * local-snapshots staging dir for `localIndexRoute`. Knowledge / ingest
 * artifacts moved to the commit-scoped `orgs/` tree, but `reposRoot()` is
 * preserved as a stable handle for downstream consumers that still need
 * the root.
 */
export function reposRoot(): string {
  return path.join(getPlumblineHome(), "repos");
}

// ── GitHub provider surface (lives in this package) ─────────────────────────
export { createPipelineRunner } from "./pipeline/run.ts";
export type { CreatePipelineRunnerDeps } from "./pipeline/run.ts";
export { createGithubIngestHandler, createLocalIngestHandler } from "./handlers/ingest-job.ts";
export type { IngestJobHandlerDeps } from "./handlers/ingest-job.ts";
export {
  fetchLatestCommitHash,
  fetchRecentCommits,
  fetchDefaultBranch,
  fetchBranches,
  parseGithubRepo,
} from "./githubApi.ts";
export type { CommitEntry, FetchCommitsResult, ParsedRepo, DefaultBranchResult } from "./githubApi.ts";
export { bootstrapRuntime } from "./bootstrap.ts";
export type { BootstrapRuntimeOptions } from "./bootstrap.ts";
// GitHub implementation of the provider-agnostic `PullSourceResolver` seam
// (clone + diff). The composition root injects this into the flat-folder pull
// driver (`@bb/ingest-strategies`' runPull).
export { resolvePullSource } from "./pipeline/pull-source-resolver.ts";
// GitHub implementation of the provider-agnostic `IndexSourceResolver` seam
// (branch + clone/stream). The composition root injects this into the public
// index runner and into any private out-of-tree index router.
export { resolveGithubIndexSource } from "./pipeline/github-index-source.ts";
