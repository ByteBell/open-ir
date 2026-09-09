// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import path from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { Config, GraphProviderType } from "@bb/types";
import { HINTS, getPlumblineHome, getConfigValue, isDevMode } from "@bb/config";
import { applyInfraDefaults, checkPreflight } from "./bootConfig.ts";
import { SetupForm } from "./SetupForm.tsx";
import { error, info, success } from "./output.ts";
import { bringInfraUp } from "./bootInfra.ts";
import { isEmbedded } from "./infraMode.ts";

export function buildBootCommand(): Command {
  const cmd = new Command("boot");
  cmd
    .description(
      "Start the plumbline-server. A Neo4j graph provider brings up Docker infra first; the embedded provider (ladybug) needs no Docker.",
    )
    .action(runBoot);
  return cmd;
}

function expandTilde(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

async function runBoot(): Promise<void> {
  if (!(await ensurePreflight())) {
    process.exitCode = 1;
    return;
  }

  if (isDevMode()) {
    info(`dev mode: logs → ${process.cwd()}/logs/`);
  }

  const defaults = applyInfraDefaults();
  for (const entry of defaults.written) {
    if (entry.redacted) {
      success(`set ${entry.cliKey}=<redacted> (auto-generated)`);
    } else {
      success(`set ${entry.cliKey} (auto-filled with default)`);
    }
  }

  const graphProvider = getConfigValue(Config.GraphProvider);

  // Embedded mode (sqlite + ladybug + honker) needs no Docker — report the
  // file-based services and skip infra startup entirely.
  if (isEmbedded()) {
    info("embedded mode — no Docker required.");
    const queueDbPath = getConfigValue(Config.QueueDbPath);
    const resolvedQueue = queueDbPath.length > 0 ? expandTilde(queueDbPath) : path.join(getPlumblineHome(), "queue.db");
    success(`queue  → honker (sqlite: ${resolvedQueue})`);
    success(`doc    → sqlite`);
    success(`graph  → ladybug`);
    process.stdout.write("\nNext: plumbline index <git-url>  or  plumbline ingest [path]\n");
    return;
  }

  if (graphProvider === GraphProviderType.Neo4j && defaults.neo4jPassword.length === 0) {
    error("internal: neo4j password is empty after applyInfraDefaults — refusing to start docker.");
    process.exitCode = 1;
    return;
  }

  info("Docker needed — bringing up infrastructure for the selected providers.");
  const upResult = await bringInfraUp(defaults.neo4jPassword);
  if (upResult === null) {
    return;
  }

  const queueDbPath = getConfigValue(Config.QueueDbPath);
  const resolvedQueueDb = queueDbPath.length > 0 ? expandTilde(queueDbPath) : path.join(getPlumblineHome(), "queue.db");
  success(`queue  → honker (sqlite: ${resolvedQueueDb})`);
  if (graphProvider === GraphProviderType.Neo4j) {
    success(`neo4j  → ${upResult.services.neo4j}`);
  }

  process.stdout.write("\nNext: plumbline index <git-url>  or  plumbline ingest [path]\n");
}

async function ensurePreflight(): Promise<boolean> {
  const initial = checkPreflight();
  if (initial.ok) {
    return true;
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    reportMissing(initial.missing);
    return false;
  }
  info("Plumbline needs a few settings before first boot — opening setup form…");
  const saved = await renderSetupForm();
  if (!saved) {
    return false;
  }
  const after = checkPreflight();
  if (after.ok) {
    return true;
  }
  reportMissing(after.missing);
  return false;
}

function reportMissing(missing: ReturnType<typeof checkPreflight>["missing"]): void {
  for (const entry of missing) {
    error(`${entry.hintKey} is not set`, HINTS[entry.configKey]);
  }
}

async function renderSetupForm(): Promise<boolean> {
  return new Promise((resolve) => {
    const onDone = (result: { saved: boolean }): void => resolve(result.saved);
    const { waitUntilExit } = render(React.createElement(SetupForm, { onDone }));
    waitUntilExit().catch(() => resolve(false));
  });
}
