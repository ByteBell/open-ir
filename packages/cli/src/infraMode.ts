// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import path from "node:path";
import { Config, DbProviderType, GraphProviderType, QueueProviderType } from "@bb/types";
import { getPlumblineHome, getConfigValue, setConfigValue } from "@bb/config";

/**
 * Infrastructure mode is not a stored flag — it's derived from the three
 * provider settings. There are two coherent presets:
 *
 *   • "docker"   (non-embedded) — SQLite + Neo4j + Honker. Requires Docker.
 *   • "embedded"                — SQLite + Ladybug + Honker. Zero Docker.
 *
 * The document store is SQLite in both: it is file-backed and needs no
 * container, so only the graph and queue providers decide whether Docker is
 * involved. The providers remain the single source of truth; `mode` is a
 * convenience the setup surfaces use to set all three at once and to decide
 * whether `boot` should bring Docker up.
 */
export type InfraMode = "docker" | "embedded";

export interface InfraModeOption {
  value: InfraMode;
  label: string;
  hint: string;
}

/**
 * UI metadata for the two infra presets, recommended preset first. This is the
 * single source for the labels/hints shown by the install wizard and the `set`
 * setup form — keep mode descriptions here, not inlined per surface.
 */
export const INFRA_MODE_OPTIONS: readonly InfraModeOption[] = [
  {
    value: "embedded",
    label: "Embedded (recommended)",
    hint: "SQLite + Ladybug + Honker — no Docker, everything in local files under ~/.plumbline",
  },
  {
    value: "docker",
    label: "Docker",
    hint: "Neo4j — Docker needed (Docker Desktop/engine must be running)",
  },
];

/** UI metadata for a single infra mode (falls back to the recommended preset). */
export function infraModeOption(mode: InfraMode): InfraModeOption {
  for (const option of INFRA_MODE_OPTIONS) {
    if (option.value === mode) {
      return option;
    }
  }
  return INFRA_MODE_OPTIONS[0] ?? { value: "embedded", label: "Embedded", hint: "" };
}

interface ProviderTriple {
  db: DbProviderType;
  graph: GraphProviderType;
  queue: QueueProviderType;
}

export const DOCKER_PROVIDERS: ProviderTriple = {
  db: DbProviderType.Sqlite,
  graph: GraphProviderType.Neo4j,
  queue: QueueProviderType.Honker,
};

export const EMBEDDED_PROVIDERS: ProviderTriple = {
  db: DbProviderType.Sqlite,
  graph: GraphProviderType.Ladybug,
  queue: QueueProviderType.Honker,
};

export type ComposeService = "neo4j";

/**
 * The Docker compose services the current provider combo requires. Empty when
 * every provider is file-based (embedded mode).
 *
 * The document store (SQLite) and the queue (Honker) are file-backed in both
 * presets and never contribute a container, so the graph provider alone decides
 * whether Docker is involved.
 */
export function composeServicesNeeded(): Set<ComposeService> {
  const needed = new Set<ComposeService>();
  if (getConfigValue(Config.GraphProvider) === GraphProviderType.Neo4j) {
    needed.add("neo4j");
  }
  return needed;
}

/** True when at least one provider needs a Docker container. */
export function needsDocker(): boolean {
  return composeServicesNeeded().size > 0;
}

/** True when the active provider combo is fully file-based (no Docker). */
export function isEmbedded(): boolean {
  return !needsDocker();
}

/**
 * Store paths derived from the plumbline home so the user never has to set them
 * by hand. An existing non-empty value (an explicit override) is left untouched.
 *
 * SQLite (documents) and Honker (queue) back both presets, so their paths are
 * always seeded; the Ladybug graph file only exists in embedded mode.
 */
const SHARED_PATH_DEFAULTS: ReadonlyArray<readonly [Config, string]> = [
  [Config.SqlitePath, "data.sqlite"],
  [Config.QueueDbPath, "queue.db"],
];

const EMBEDDED_PATH_DEFAULTS: ReadonlyArray<readonly [Config, string]> = [[Config.LadybugPath, "ladybug.lbug"]];

/** Fill any unset path key with `<plumbline home>/<filename>`. */
function seedPaths(entries: ReadonlyArray<readonly [Config, string]>): void {
  const home = getPlumblineHome();
  for (const [key, filename] of entries) {
    const current = getConfigValue(key);
    if (typeof current === "string" && current.length === 0) {
      setConfigValue(key, path.join(home, filename));
    }
  }
}

/** Apply one of the two presets to the three provider config keys. */
export function applyInfraMode(mode: InfraMode): void {
  const providers = mode === "embedded" ? EMBEDDED_PROVIDERS : DOCKER_PROVIDERS;
  setConfigValue(Config.DbProvider, providers.db);
  setConfigValue(Config.GraphProvider, providers.graph);
  setConfigValue(Config.QueueProvider, providers.queue);
  seedPaths(SHARED_PATH_DEFAULTS);
  if (mode !== "embedded") {
    return;
  }
  seedPaths(EMBEDDED_PATH_DEFAULTS);
}
