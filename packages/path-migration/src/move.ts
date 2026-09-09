import path from "node:path";
import { stat, rename, mkdir, readdir, rm, cp } from "node:fs/promises";
import {
  plumblinePathsFor,
  parseGithubOwnerRepo,
  repositoryDirFor,
  type KnowledgeDoc,
  type RepoLocation,
} from "@bb/types";
import type { MigrationSummary } from "./types.ts";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function renameOrCopy(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (cause: unknown) {
    // Cross-device rename failure (EXDEV) — fall back to recursive copy + remove.
    if (cause instanceof Error && "code" in cause && (cause as { code?: unknown }).code === "EXDEV") {
      await cp(src, dst, { recursive: true });
      await rm(src, { recursive: true, force: true });
      return;
    }
    throw cause;
  }
}

interface MoveCtx {
  home: string;
  dryRun: boolean;
  knowledgeId: string;
  summary: MigrationSummary;
}

async function moveCloneIfPresent(ctx: MoveCtx, legacyCloneDir: string, newLoc: RepoLocation): Promise<void> {
  if (!(await pathExists(legacyCloneDir))) {
    return;
  }
  const newCloneDir = repositoryDirFor(ctx.home, newLoc);
  if (await pathExists(newCloneDir)) {
    ctx.summary.skippedAlready.push(`${ctx.knowledgeId} (clone)`);
    return;
  }
  if (!ctx.dryRun) {
    await mkdir(path.dirname(newCloneDir), { recursive: true, mode: 0o700 });
    await renameOrCopy(legacyCloneDir, newCloneDir);
  }
  ctx.summary.migrated.push(`${ctx.knowledgeId} (clone)`);
}

async function moveMetaIfPresent(ctx: MoveCtx, legacyMetaRoot: string, newLoc: RepoLocation): Promise<void> {
  if (!(await pathExists(legacyMetaRoot))) {
    return;
  }
  const newMetaOutput = plumblinePathsFor(ctx.home, newLoc).metaOutputRoot;
  if (await pathExists(newMetaOutput)) {
    ctx.summary.skippedAlready.push(`${ctx.knowledgeId} (meta-output)`);
    return;
  }
  if (!ctx.dryRun) {
    await mkdir(path.dirname(newMetaOutput), { recursive: true, mode: 0o700 });
    await renameOrCopy(legacyMetaRoot, newMetaOutput);
    // Pull commits/<commitHash>/business-context/ contents UP into
    // meta-output/business-context/ for the new layout's expectation.
    await flattenLegacyBusinessContext(newMetaOutput, newLoc);
  }
  ctx.summary.migrated.push(`${ctx.knowledgeId} (meta-output)`);
}

async function flattenLegacyBusinessContext(metaOutputRoot: string, loc: RepoLocation): Promise<void> {
  // Legacy: metaOutputRoot/commits/<commitHash>/business-context/<title>/...
  // New:    metaOutputRoot/business-context/<title>/...
  // We only flatten contexts authored against the current head commit; older
  // commits stay nested for forensic access.
  const commitsDir = path.join(metaOutputRoot, "commits");
  if (!(await pathExists(commitsDir))) {
    return;
  }
  const currentCommitBcDir = path.join(commitsDir, loc.commitHash, "business-context");
  if (!(await pathExists(currentCommitBcDir))) {
    return;
  }
  const targetBcDir = path.join(metaOutputRoot, "business-context");
  await mkdir(targetBcDir, { recursive: true, mode: 0o700 });
  const titles = await readdir(currentCommitBcDir);
  for (const title of titles) {
    const src = path.join(currentCommitBcDir, title);
    const dst = path.join(targetBcDir, title);
    if (await pathExists(dst)) {
      continue;
    }
    await renameOrCopy(src, dst);
  }
}

interface MigrateOneInput {
  home: string;
  orgId: string;
  doc: KnowledgeDoc;
  dryRun: boolean;
  summary: MigrationSummary;
}

/**
 * Migrates a single knowledge's legacy clone + meta dirs into the commit-scoped
 * layout. Records skip/fail reasons in `summary`; never throws for an expected
 * skip. Local sources have no managed clone — only meta-output moves, under a
 * synthetic commit hash derived from `updatedAt`.
 */
export async function migrateOne(input: MigrateOneInput): Promise<void> {
  const { home, orgId, doc, dryRun, summary } = input;
  const knowledgeId = doc.knowledgeId;
  const ctx: MoveCtx = { home, dryRun, knowledgeId, summary };
  const legacyCloneDir = path.join(home, "repos", knowledgeId);
  const legacyMetaRoot = path.join(home, "repos", ".meta", knowledgeId);

  if (doc.source.kind === "local") {
    const syntheticCommit = `migrated-${doc.updatedAt.getTime()}`;
    const newLoc: RepoLocation = {
      provider: "local",
      orgId,
      knowledgeId,
      branch: doc.info.branch ?? "main",
      commitHash: syntheticCommit,
    };
    await moveMetaIfPresent(ctx, legacyMetaRoot, newLoc);
    return;
  }

  const commitId = doc.source.commitId;
  if (commitId === undefined || commitId.length === 0) {
    summary.skippedNoCommit.push(knowledgeId);
    return;
  }
  const repoUrl = doc.info.repoUrl;
  if (repoUrl === undefined || repoUrl.length === 0) {
    summary.skippedNoRepoUrl.push(knowledgeId);
    return;
  }
  const parsed = parseGithubOwnerRepo(repoUrl);
  if (parsed === null) {
    summary.failed.push({ knowledgeId, reason: `could not parse owner/repo from ${repoUrl}` });
    return;
  }
  const newLoc: RepoLocation = {
    provider: "github",
    orgId,
    knowledgeId,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: doc.info.branch ?? "main",
    commitHash: commitId,
  };
  await moveCloneIfPresent(ctx, legacyCloneDir, newLoc);
  await moveMetaIfPresent(ctx, legacyMetaRoot, newLoc);
}
