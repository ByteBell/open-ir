// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Config, DbProviderType, GraphProviderType, QueueProviderType } from "@bb/types";
import { getPlumblineHome, getConfigValue, requiredKeysFor } from "@bb/config";
import { bringInfraUp } from "./dockerBoot.ts";
import { KEY_MAP } from "./keyMap.ts";
import { success, error, info } from "./output.ts";
import { isEmbedded } from "./infraMode.ts";
import { startServer } from "./serverLifecycle.ts";

const DEFAULT_NEO4J_URI = "bolt://127.0.0.1:7687";
const DEFAULT_NEO4J_USER = "neo4j";

interface DefaultEntry {
  cliKey: string;
  configKey: Config;
  computeDefault: () => string;
  /** Only auto-fill when the active provider combo actually uses this service. */
  needed: () => boolean;
}

function usingNeo4j(): boolean {
  return getConfigValue(Config.GraphProvider) === GraphProviderType.Neo4j;
}

const DEFAULTS: readonly DefaultEntry[] = [
  { cliKey: "neo4j", configKey: Config.Neo4jUri, computeDefault: () => DEFAULT_NEO4J_URI, needed: usingNeo4j },
  { cliKey: "neo4j-user", configKey: Config.Neo4jUser, computeDefault: () => DEFAULT_NEO4J_USER, needed: usingNeo4j },
  {
    cliKey: "neo4j-password",
    configKey: Config.Neo4jPassword,
    computeDefault: generateNeo4jPassword,
    needed: usingNeo4j,
  },
  // File-backed stores live under ~/.plumbline. These are auto-filled (and
  // required by the server preflight) because the providers don't all default
  // to a persistent path on their own — notably Ladybug treats an empty path as
  // in-memory, which would silently lose the graph on restart.
  {
    cliKey: "sqlite-path",
    configKey: Config.SqlitePath,
    computeDefault: () => path.join(getPlumblineHome(), "data.sqlite"),
    needed: () => getConfigValue(Config.DbProvider) === DbProviderType.Sqlite,
  },
  {
    cliKey: "ladybug-path",
    configKey: Config.LadybugPath,
    computeDefault: () => path.join(getPlumblineHome(), "ladybug.lbug"),
    needed: () => getConfigValue(Config.GraphProvider) === GraphProviderType.Ladybug,
  },
  {
    cliKey: "queue-db-path",
    configKey: Config.QueueDbPath,
    computeDefault: () => path.join(getPlumblineHome(), "queue.db"),
    needed: () => getConfigValue(Config.QueueProvider) === QueueProviderType.Honker,
  },
];

export interface ApplyDefaultsResult {
  written: { cliKey: string; redacted: boolean }[];
  neo4jPassword: string;
}

export function applyInfraDefaults(): ApplyDefaultsResult {
  const written: { cliKey: string; redacted: boolean }[] = [];
  for (const entry of DEFAULTS) {
    if (!entry.needed()) {
      continue;
    }
    const current = readString(entry.configKey);
    if (current.length > 0) {
      continue;
    }
    const value = entry.computeDefault();
    const setter = KEY_MAP[entry.cliKey];
    if (setter === undefined) {
      throw new Error(`internal: KEY_MAP entry "${entry.cliKey}" missing`);
    }
    setter.setter(value);
    written.push({ cliKey: entry.cliKey, redacted: setter.redact });
  }
  return {
    written,
    neo4jPassword: readString(Config.Neo4jPassword),
  };
}

export interface PreflightResult {
  ok: boolean;
  missing: { configKey: Config; hintKey: string }[];
}

const CONFIG_HINT_KEYS: Partial<Record<Config, string>> = {
  [Config.OpenrouterApiKey]: "openrouter-api-key",
  [Config.OpenrouterModel]: "openrouter-model",
  [Config.OllamaUrl]: "ollama-url",
  [Config.OllamaModel]: "ollama-model",
};

export function checkPreflight(): PreflightResult {
  const provider = getConfigValue(Config.LlmProvider);
  const required = requiredKeysFor(provider);
  const missing: PreflightResult["missing"] = [];
  for (const configKey of required) {
    const value = getConfigValue(configKey);
    const isEmpty = typeof value === "string" ? value.length === 0 : false;
    if (isEmpty) {
      const hintKey = CONFIG_HINT_KEYS[configKey] ?? String(configKey);
      missing.push({ configKey, hintKey });
    }
  }
  return { ok: missing.length === 0, missing };
}

export async function runBootSequence(): Promise<boolean> {
  const defaults = applyInfraDefaults();
  for (const entry of defaults.written) {
    if (entry.redacted) {
      success(`set ${entry.cliKey}=<redacted> (auto-generated)`);
    } else {
      success(`set ${entry.cliKey} (auto-filled with default)`);
    }
  }

  // Embedded mode (sqlite + ladybug + honker) needs no external services — skip
  // Docker entirely and go straight to starting the server.
  if (isEmbedded()) {
    info("embedded mode — no Docker required (sqlite + ladybug + honker).");
  } else {
    if (getConfigValue(Config.GraphProvider) === GraphProviderType.Neo4j && defaults.neo4jPassword.length === 0) {
      error("internal: neo4j password is empty after applyInfraDefaults — refusing to start docker.");
      process.exitCode = 1;
      return false;
    }

    const upResult = await bringInfraUp(defaults.neo4jPassword);
    if (upResult === null) {
      return false;
    }
    if (getConfigValue(Config.GraphProvider) === GraphProviderType.Neo4j) {
      success(`neo4j  → ${upResult.services.neo4j}`);
    }
  }

  const started = await startServer();
  if (!started) {
    return false;
  }

  const port = getConfigValue(Config.ServerPort);
  success(`MCP endpoint: http://127.0.0.1:${port}/mcp`);
  return true;
}

function readString(key: Config): string {
  const value = getConfigValue(key);
  return typeof value === "string" ? value : "";
}

function generateNeo4jPassword(): string {
  return randomBytes(24).toString("base64url");
}
