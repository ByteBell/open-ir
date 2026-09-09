// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getPlumblineHome } from "@bb/config";
import {
  ServerStartTimeoutError,
  ServerInfraDownError,
  ServerInfraUnreachableError,
  ServerProcessExitedError,
} from "@bb/errors";
import { ensureServerRunning } from "./serverSpawn.ts";
import { createSpinner, error } from "./output.ts";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

async function readPid(pidFile: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFile, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function waitForPidFileGone(pidFile: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (!(await pidFileExists(pidFile))) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return !(await pidFileExists(pidFile));
}

async function pidFileExists(pidFile: string): Promise<boolean> {
  try {
    await stat(pidFile);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StopServerResult {
  wasRunning: boolean;
  timedOut: boolean;
  pid: number | null;
}

export async function stopServer(): Promise<StopServerResult> {
  const pidFile = path.join(getPlumblineHome(), "pid");
  const pid = await readPid(pidFile);
  if (pid === null) {
    return { wasRunning: false, timedOut: false, pid: null };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (cause: unknown) {
    const code =
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      typeof (cause as Record<string, unknown>)["code"] === "string"
        ? ((cause as Record<string, unknown>)["code"] as string)
        : undefined;
    if (code === "ESRCH") {
      return { wasRunning: false, timedOut: false, pid };
    }
    throw cause;
  }
  const drained = await waitForPidFileGone(pidFile);
  return { wasRunning: true, timedOut: !drained, pid };
}

export async function startServer(): Promise<boolean> {
  const spinner = createSpinner("Starting ByteBell server...");
  try {
    const ctx = await ensureServerRunning((line) => spinner.update(`Server: ${line}`));
    if (ctx.alreadyRunning) {
      spinner.stop(true, "Server already running");
    } else {
      spinner.stop(true, `Server started (logs: ${ctx.logPath ?? "n/a"})`);
    }
    return true;
  } catch (cause: unknown) {
    spinner.stop(false, "Server startup failed");
    if (cause instanceof ServerProcessExitedError) {
      error(cause.message);
      if (cause.logTail.length > 0) {
        error(cause.logTail);
      }
    } else if (cause instanceof ServerInfraUnreachableError) {
      error(`Infra not reachable: ${cause.services.map((s) => `${s.name} (${s.uri})`).join(", ")}. Is Docker running?`);
    } else if (cause instanceof ServerInfraDownError) {
      error(`Infra not reachable: ${cause.services.join(", ")}. Is Docker running?`);
    } else if (cause instanceof ServerStartTimeoutError) {
      error(cause.message);
    } else {
      error(cause instanceof Error ? cause.message : String(cause));
    }
    process.exitCode = 1;
    return false;
  }
}
