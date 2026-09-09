import { Command } from "commander";
import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import { ensureServerRunning } from "./serverSpawn.ts";
import { ServerStartTimeoutError } from "@bb/errors";
import { getJson, HttpClientError, postJson } from "./httpClient.ts";
import { createProgressBar, createSpinner, error, info, type ProgressBar } from "./output.ts";
import { hasIngestProgress, updateIngestBar, type IngestProgressFields } from "./progressLabel.ts";
import { startLogTailer, type LogTailer } from "./logTailer.ts";
import { promptRepoSelector } from "./repoSelectorPrompt.ts";
import { promptPullMode, resolveCommit } from "./pullPrompts.ts";

interface PullResponse {
  knowledgeId: string;
  jobId?: string;
  noOp?: boolean;
  commitHash?: string;
}

interface RepoStatus extends IngestProgressFields {
  knowledgeId: string;
  state: string;
  fileCount: number;
}

export function buildPullCommand(): Command {
  const cmd = new Command("pull");
  cmd
    .description("Re-index a previously added GitHub repo at the branch's current HEAD.")
    .argument("[knowledge-id]", "knowledge id (omit to pick interactively from the indexed repos)")
    .option("--commit <sha>", "specific commit hash to anchor against (defaults to branch HEAD)")
    .option("--token <pat>", "GitHub PAT for private repos")
    .option("--verbose", "stream the server log file to the terminal during the run")
    .action(runPull);
  return cmd;
}

async function runPull(
  knowledgeId: string | undefined,
  options: { commit?: string; token?: string; verbose?: boolean },
): Promise<void> {
  let tailer: LogTailer | null = null;
  try {
    let ctx: Awaited<ReturnType<typeof ensureServerRunning>>;
    if (
      await fetch(`http://127.0.0.1:${getConfigValue(Config.ServerPort)}/health`)
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ctx = await ensureServerRunning();
    } else {
      const spinner = createSpinner("Starting ByteBell server in background...");
      ctx = await ensureServerRunning((line) => spinner.update(line));
      spinner.stop(true, `Server started (logs: ${ctx.logPath ?? "n/a"})`);
    }

    // No id supplied → interactive picker, github-only (pull doesn't apply to local repos).
    const picks =
      knowledgeId !== undefined && knowledgeId.length > 0 ? [{ knowledgeId, label: knowledgeId }] : await pickRepos();
    if (picks.length === 0) {
      info("No repo selected.");
      return;
    }

    // If a single repo was picked and the caller did not pre-supply --commit,
    // give the user the latest-vs-specific choice. For multi-repo selections
    // we apply the same target (or HEAD) to every repo — letting the user pick
    // a different commit per repo would require a sub-prompt per repo which
    // is not worth the complexity for the rare multi-pull case.
    let chosenTargetCommit: string | undefined = options.commit;
    let activeToken: string | undefined = options.token;
    if (chosenTargetCommit === undefined && picks.length === 1) {
      const only = picks[0];
      if (only !== undefined) {
        const mode = await promptPullMode(only.label);
        if (mode === null) {
          info("Cancelled.");
          return;
        }
        if (mode === "specific") {
          const picked = await resolveCommit(only.knowledgeId, only.label, activeToken);
          if (picked === null) {
            info("Cancelled.");
            return;
          }
          chosenTargetCommit = picked.hash;
          if (picked.token !== undefined) {
            activeToken = picked.token;
          }
        }
      }
    }

    if (options.verbose === true) {
      tailer = await startLogTailer("server");
    }

    // Enqueue all pulls upfront — the queue runs workers concurrently in the
    // server process, so there's no benefit to serialising the HTTP submits.
    const enqueueResults = await Promise.all(
      picks.map(async ({ knowledgeId: targetId }) => {
        const body: Record<string, string> = { knowledgeId: targetId };
        if (chosenTargetCommit !== undefined) {
          body["targetCommitHash"] = chosenTargetCommit;
        }
        if (activeToken !== undefined) {
          body["gitToken"] = activeToken;
        }
        const response = await postJson<PullResponse>("/api/v1/github/pull", body);
        return { targetId, response };
      }),
    );

    const polling: Array<{ knowledgeId: string; jobId: string }> = [];
    for (const { targetId, response } of enqueueResults) {
      if (response.noOp === true) {
        info(`No-op: knowledge ${targetId} already at commit ${response.commitHash ?? "(unknown)"}`);
        continue;
      }
      if (response.jobId === undefined) {
        error(`Pull was not enqueued for knowledge ${targetId}`);
        process.exitCode = 1;
        continue;
      }
      polling.push({ knowledgeId: response.knowledgeId, jobId: response.jobId });
    }

    // Poll every enqueued job in parallel so progress for all repos updates
    // concurrently rather than blocking on the first one to finish.
    await Promise.all(polling.map(({ knowledgeId: kid, jobId }) => pollJobStatus(kid, jobId)));
  } catch (cause: unknown) {
    handleError(cause);
  } finally {
    if (tailer !== null) {
      await tailer.stop();
    }
  }
}

interface RepoPick {
  knowledgeId: string;
  label: string;
}

async function pickRepos(): Promise<RepoPick[]> {
  const result = await promptRepoSelector({
    title: "Select repos to pull",
    filterKind: "github",
    emptyMessage: "No indexed GitHub repos. Run `plumbline index <url>` first.",
  });
  if (result === null) {
    return [];
  }
  return result.picked.map((p) => ({ knowledgeId: p.item.knowledgeId, label: p.item.label }));
}

async function pollJobStatus(knowledgeId: string, jobId: string): Promise<void> {
  const spinner = createSpinner(`Pulling knowledge ${knowledgeId} (job ${jobId})...`);
  let bar: ProgressBar | null = null;
  const pollInterval = 1500;

  while (true) {
    try {
      const status = await getJson<RepoStatus>(`/api/v1/repos/${knowledgeId}`);

      if (hasIngestProgress(status)) {
        if (bar === null) {
          spinner.stop(true, `Re-ingesting ${knowledgeId}`);
          bar = createProgressBar(`Re-ingesting ${knowledgeId}`);
        }
        updateIngestBar(bar, status, `Re-ingesting ${knowledgeId}`);
      } else {
        spinner.update(`Pulling: ${status.state}${status.fileCount > 0 ? ` (${status.fileCount} files)` : ""}`);
      }

      if (status.state === "PROCESSED") {
        if (bar) {
          bar.stop(true, `Successfully pulled ${knowledgeId} (${status.fileCount} files)`);
        } else {
          spinner.stop(true, `Successfully pulled ${knowledgeId} (${status.fileCount} files)`);
        }
        return;
      }
      if (status.state === "FAILED") {
        if (bar) {
          bar.stop(false, `Pull failed for ${knowledgeId}`);
        } else {
          spinner.stop(false, `Pull failed for ${knowledgeId}`);
        }
        return;
      }
    } catch (cause: unknown) {
      const msg = `Failed to poll status: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (bar) {
        bar.stop(false, msg);
      } else {
        spinner.stop(false, msg);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

function handleError(cause: unknown): void {
  if (cause instanceof ServerStartTimeoutError) {
    error(cause.message);
  } else if (cause instanceof HttpClientError) {
    error(cause.message);
  } else {
    error(cause instanceof Error ? cause.message : String(cause));
  }
  process.exitCode = 1;
}
