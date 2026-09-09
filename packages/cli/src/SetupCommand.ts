// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import { InstallWizard, type InstallWizardResult } from "./InstallWizard.tsx";
import { KEY_MAP } from "./keyMap.ts";
import { applyInfraMode } from "./infraMode.ts";
import { runBootSequence } from "./bootConfig.ts";
import { stopServer } from "./serverLifecycle.ts";
import { postJson, HttpClientError } from "./httpClient.ts";
import { success, error, info } from "./output.ts";
import { pollIndexToCompletion, type IndexResponse } from "./indexPoller.ts";
import { probeRepo } from "./repoProbe.ts";
import { runMcpInstall } from "./mcpInstall.ts";

export function buildSetupCommand(): Command {
  const cmd = new Command("setup");
  cmd.description("Interactive first-run wizard: configure LLM provider, then boot.").action(runSetup);
  return cmd;
}

async function runSetup(): Promise<void> {
  if (process.stdin.isTTY !== true) {
    error("plumbline setup requires an interactive terminal. Run it directly, not piped.");
    process.exitCode = 1;
    return;
  }
  const result = await runWizard();
  if (result === null) {
    info("Setup cancelled.");
    return;
  }
  try {
    applyConfig(result);
  } catch (cause: unknown) {
    error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
    return;
  }
  const booted = await boot();
  if (!booted) {
    return;
  }
  if (result.indexUrl !== undefined) {
    await startIndex(result.indexUrl);
  }
  await connectMcp();
}

async function connectMcp(): Promise<void> {
  const summary = await runMcpInstall().catch(() => null);
  if (summary !== null && summary.configured > 0) {
    return;
  }
  const port = getConfigValue(Config.ServerPort);
  success(`Connect Claude Code:\n  claude mcp add --transport http plumbline http://127.0.0.1:${port}/mcp`);
}

function runWizard(): Promise<InstallWizardResult | null> {
  return new Promise<InstallWizardResult | null>((resolve) => {
    let resolved = false;
    const app = render(
      React.createElement(InstallWizard, {
        onDone: (res) => {
          if (!resolved) {
            resolved = true;
            app.unmount();
            resolve(res);
          }
        },
      }),
    );
    app
      .waitUntilExit()
      .then(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      })
      .catch(() => undefined);
  });
}

function applyConfig(result: InstallWizardResult): void {
  // Infrastructure mode sets the db/graph/queue providers as a single preset.
  applyInfraMode(result.infraMode);

  const providerEntry = KEY_MAP["llm-provider"];
  if (providerEntry === undefined) {
    throw new Error("internal: KEY_MAP missing 'llm-provider'");
  }
  providerEntry.setter(result.provider);

  if (result.provider === "openrouter") {
    const keyEntry = KEY_MAP["openrouter-api-key"];
    const modelEntry = KEY_MAP["openrouter-model"];
    if (keyEntry === undefined) {
      throw new Error("internal: KEY_MAP missing 'openrouter-api-key'");
    }
    if (modelEntry === undefined) {
      throw new Error("internal: KEY_MAP missing 'openrouter-model'");
    }
    if (result.openrouterApiKey !== undefined) {
      keyEntry.setter(result.openrouterApiKey);
    }
    if (result.openrouterModel !== undefined) {
      modelEntry.setter(result.openrouterModel);
    }
    success(`OpenRouter configured (model: ${result.openrouterModel ?? "(not set)"})`);
  } else {
    const urlEntry = KEY_MAP["ollama-url"];
    const modelEntry = KEY_MAP["ollama-model"];
    if (urlEntry === undefined) {
      throw new Error("internal: KEY_MAP missing 'ollama-url'");
    }
    if (modelEntry === undefined) {
      throw new Error("internal: KEY_MAP missing 'ollama-model'");
    }
    if (result.ollamaUrl !== undefined) {
      urlEntry.setter(result.ollamaUrl);
    }
    if (result.ollamaModel !== undefined) {
      modelEntry.setter(result.ollamaModel);
    }
    success(`Ollama configured (model: ${result.ollamaModel ?? "(not set)"})`);
  }
}

async function boot(): Promise<boolean> {
  const result = await stopServer().catch(() => ({ wasRunning: false, timedOut: false, pid: null }));
  if (result.wasRunning) {
    info("Stopped running server.");
  }
  return runBootSequence();
}

async function startIndex(repoUrl: string): Promise<void> {
  const probe = await probeRepo(repoUrl);
  if (probe.branch === null) {
    return;
  }
  const body: Record<string, string> = { repoUrl, branch: probe.branch };
  if (probe.token !== undefined) {
    body["gitToken"] = probe.token;
  }
  let res: IndexResponse;
  try {
    res = await postJson<IndexResponse>("/api/v1/github/index", body);
  } catch (cause: unknown) {
    if (cause instanceof HttpClientError) {
      error(`Failed to start indexing: ${cause.message}`);
    } else {
      error(`Failed to start indexing: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return;
  }

  await pollIndexToCompletion(res.knowledgeId, res.jobId);
}
