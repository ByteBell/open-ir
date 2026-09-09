// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { Command } from "commander";
import { DockerComposeError, DockerNotFoundError, composeFilePath, down } from "./dockerInfra.ts";
import { createSpinner, error } from "./output.ts";
import { promptStopDocker } from "./shutdownPrompts.ts";
import { stopServer } from "./serverLifecycle.ts";
import { isEmbedded } from "./infraMode.ts";

const STOP_TIMEOUT_S = 30;

interface ShutdownOptions {
  withDocker?: boolean;
  keepDocker?: boolean;
}

export function buildShutdownCommand(): Command {
  const cmd = new Command("shutdown");
  cmd
    .description("Stop the plumbline-server (and optionally Docker infra).")
    .option("--with-docker", "also stop Docker infra without prompting")
    .option("--keep-docker", "leave Docker infra running without prompting")
    .action((opts: ShutdownOptions) => runShutdown(opts));
  return cmd;
}

async function runShutdown(opts: ShutdownOptions): Promise<void> {
  if (opts.withDocker === true && opts.keepDocker === true) {
    error("--with-docker and --keep-docker are mutually exclusive.");
    process.exitCode = 1;
    return;
  }

  const spinner = createSpinner("Shutting down ByteBell server...");
  let result: Awaited<ReturnType<typeof stopServer>>;
  try {
    result = await stopServer();
  } catch (cause: unknown) {
    spinner.stop(false, "Failed to send SIGTERM");
    error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
    return;
  }

  if (!result.wasRunning) {
    spinner.stop(true, "server is not running.");
    process.stdout.write(dockerHint());
    return;
  }

  if (result.timedOut) {
    spinner.stop(
      false,
      `server (pid ${result.pid}) did not exit within ${STOP_TIMEOUT_S}s; not escalating to SIGKILL.`,
    );
    process.exitCode = 1;
    process.stdout.write(dockerHint());
    return;
  }

  spinner.stop(true, `server (pid ${result.pid}) shut down gracefully.`);

  const shouldStop = await decideStopDocker(opts);
  if (shouldStop) {
    await stopDocker();
  } else {
    process.stdout.write(dockerHint());
  }
}

async function decideStopDocker(opts: ShutdownOptions): Promise<boolean> {
  // Embedded mode runs no Docker — never prompt or try to tear it down.
  if (isEmbedded()) {
    return false;
  }
  if (opts.withDocker === true) {
    return true;
  }
  if (opts.keepDocker === true) {
    return false;
  }
  if (process.stdin.isTTY !== true) {
    return false;
  }
  return promptStopDocker();
}

async function stopDocker(): Promise<void> {
  const spinner = createSpinner("Stopping Docker infrastructure...");
  try {
    await down();
    spinner.stop(true, "Docker infra stopped.");
  } catch (cause: unknown) {
    spinner.stop(false, "Docker shutdown failed");
    if (cause instanceof DockerNotFoundError) {
      error(cause.message);
    } else if (cause instanceof DockerComposeError) {
      error(cause.message);
    } else {
      error(cause instanceof Error ? cause.message : String(cause));
    }
    process.exitCode = 1;
    process.stdout.write(dockerHint());
  }
}

function dockerHint(): string {
  // No Docker in embedded mode — nothing to hint about.
  if (isEmbedded()) {
    return "";
  }
  return `\nDocker infra is still running. To stop it:\n  docker compose -f ${composeFilePath()} down\n`;
}
