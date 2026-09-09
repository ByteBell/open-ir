// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { Command } from "commander";
import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import { ensureServerRunning } from "./serverSpawn.ts";
import { ServerStartTimeoutError } from "@bb/errors";
import { HttpClientError, postJson } from "./httpClient.ts";
import { createSpinner, error } from "./output.ts";
import { startLogTailer, type LogTailer } from "./logTailer.ts";
import { pollIndexToCompletion, type IndexResponse } from "./indexPoller.ts";
import { probeRepo } from "./repoProbe.ts";

export function buildIndexCommand(): Command {
  const cmd = new Command("index");
  cmd
    .description("Index a remote git repository.")
    .argument("<git-url>", "https URL of the repository")
    .option("--branch <name>", "branch to index (defaults to 'main' on the server)")
    .option("--token <pat>", "GitHub PAT for private repos")
    .option(
      "--verbose",
      "stream the server log file to the terminal during the run (set log level via `plumbline set log-level debug` for finer-grained output)",
    )
    .action(runIndex);
  return cmd;
}

async function runIndex(
  gitUrl: string,
  options: { branch?: string; token?: string; verbose?: boolean },
): Promise<void> {
  if (!/^https?:\/\//u.test(gitUrl)) {
    error(`invalid git URL: ${gitUrl}`, "expected https://… form");
    process.exitCode = 1;
    return;
  }
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
    if (options.verbose === true) {
      tailer = await startLogTailer("server");
    }

    const { branch: resolvedBranch, token: activeToken } = await probeRepo(gitUrl, options.branch, options.token);
    if (resolvedBranch === null) {
      return;
    }

    const body: Record<string, string> = { repoUrl: gitUrl, branch: resolvedBranch };
    if (activeToken !== undefined) {
      body["gitToken"] = activeToken;
    }
    const response = await postJson<IndexResponse>("/api/v1/github/index", body);
    await pollIndexToCompletion(response.knowledgeId, response.jobId);
  } catch (cause: unknown) {
    handleError(cause);
  } finally {
    if (tailer !== null) {
      await tailer.stop();
    }
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
