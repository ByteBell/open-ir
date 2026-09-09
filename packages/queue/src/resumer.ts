// Boot-time Orphan Resumer — bridges the gap between the publisher's
// `setKnowledgeState(QUEUED)` write and the provider's `enqueueRaw` call.
//
// If the server crashes (kill -9, OOM, SIGKILL) between those two steps,
// the knowledge doc is left in `QUEUED` state with no corresponding live
// job. Workers never claim it; the user sees a stuck row in `plumbline ls`.
//
// On boot we scan `@bb/db` for any knowledge doc in `state === QUEUED` and
// re-publish it via the appropriate `enqueue*` publisher. The provider's
// dedupe-check makes this safe for the case where the crash happened
// *after* the publish (the existing live job's id is returned; no
// duplicate row is created).
//
// Scope: GitHub-kind knowledge only. `enqueueLocalIngest` deliberately
// skips `setKnowledgeState`, so a `QUEUED` doc can only come from a
// `GithubIndex` / `GithubPull` publish.
//
// Limitation: optional payload fields not persisted on the knowledge doc
// (`gitToken`, LLM overrides) are not recoverable here. Private-repo jobs
// that crashed mid-publish will fail to re-clone and need a manual
// `POST /api/v1/index/github` to resupply credentials.

import { KnowledgeState, type GithubIndexPayload, type KnowledgeListEntry } from "@bb/types";
import { knowledgeDb } from "@bb/db";
import { logger } from "@bb/logger";
import { enqueueGithubIndex } from "./github-index.ts";

export interface ResumeResult {
  scanned: number;
  resumed: number;
  skipped: number;
}

export async function resumeOrphans(): Promise<ResumeResult> {
  // listKnowledge has no state filter today — pull a generous page and
  // filter in-memory. Bounded by the total knowledge-doc count, which is
  // small in OSS single-user.
  const all = await knowledgeDb.listKnowledge({ limit: 10_000 });
  const queued = all.filter((k) => k.status.state === KnowledgeState.Queued);
  let resumed = 0;
  let skipped = 0;
  for (const k of queued) {
    const payload = buildGithubPayload(k);
    if (payload === null) {
      logger.warn(`queue.resume: skipping knowledgeId=${k.knowledgeId} (no repoUrl on doc)`);
      skipped += 1;
      continue;
    }
    try {
      await enqueueGithubIndex(payload);
      resumed += 1;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`queue.resume: failed to re-publish knowledgeId=${k.knowledgeId}: ${reason}`);
      skipped += 1;
    }
  }
  return { scanned: queued.length, resumed, skipped };
}

function buildGithubPayload(k: KnowledgeListEntry): GithubIndexPayload | null {
  if (k.source.kind !== "github") {
    // Local-kind docs in QUEUED state shouldn't exist (enqueueLocalIngest
    // doesn't write the state), but be defensive — skip them anyway.
    return null;
  }
  const repoUrl = readRepoUrl(k);
  if (repoUrl === undefined) {
    return null;
  }
  const payload: GithubIndexPayload = {
    knowledgeId: k.knowledgeId,
    repoUrl,
  };
  const branch = readBranch(k);
  if (branch !== undefined) {
    payload.branch = branch;
  }
  return payload;
}

function readRepoUrl(k: KnowledgeListEntry): string | undefined {
  const info = k.info;
  if (typeof info.repoUrl === "string" && info.repoUrl.length > 0) {
    return info.repoUrl;
  }
  if (typeof info.git_url === "string" && info.git_url.length > 0) {
    return info.git_url;
  }
  return undefined;
}

function readBranch(k: KnowledgeListEntry): string | undefined {
  const info = k.info;
  if (typeof info.branch === "string" && info.branch.length > 0) {
    return info.branch;
  }
  const ghInfo = info.githubInfo;
  if (
    typeof ghInfo === "object" &&
    ghInfo !== null &&
    "branchName" in ghInfo &&
    typeof (ghInfo as { branchName: unknown }).branchName === "string"
  ) {
    const v = (ghInfo as { branchName: string }).branchName;
    if (v.length > 0) {
      return v;
    }
  }
  return undefined;
}
