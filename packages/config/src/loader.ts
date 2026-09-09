import fs from "node:fs";
import {
  parseConfig,
  Config,
  type PlumblineConfig,
  type ConfigValue,
  HINTS,
  readField,
  requiredKeysFor,
} from "./schema.ts";
import { __registerCacheInvalidator, getConfigPath, resolveUnderHome } from "./paths.ts";
import { ensurePlumblineHome } from "./writer.ts";

let cached: PlumblineConfig | null = null;
let seeded = false;

__registerCacheInvalidator(() => {
  if (seeded) {
    return;
  }
  cached = null;
});

export function seedConfig(value: unknown): PlumblineConfig {
  cached = parseConfig(value);
  seeded = true;
  return cached;
}

export function __isSeeded(): boolean {
  return seeded;
}

export function __resetSeedForTests(): void {
  cached = null;
  seeded = false;
}

export function loadConfig(): PlumblineConfig {
  if (cached !== null) {
    return cached;
  }
  ensurePlumblineHome();
  const raw = fs.readFileSync(getConfigPath(), "utf8");
  const parsed: unknown = JSON.parse(raw);
  cached = parseConfig(parsed);
  return cached;
}

/** Path-valued keys whose stored value is resolved to an absolute path on read. */
const PATH_KEYS: ReadonlySet<Config> = new Set([Config.SqlitePath, Config.LadybugPath, Config.QueueDbPath]);

export function getConfigValue<K extends Config>(key: K): ConfigValue<K> {
  const value = readField(loadConfig(), key);
  if (typeof value === "string" && PATH_KEYS.has(key)) {
    return resolveUnderHome(value) as ConfigValue<K>;
  }
  return value;
}

export type ConfigCompletenessResult = { ok: true } | { ok: false; missing: Config[]; hints: string[] };

export function isConfigComplete(): ConfigCompletenessResult {
  const cfg = loadConfig();
  const missing: Config[] = [];
  for (const key of requiredKeysFor(cfg.llm_provider)) {
    const value = readField(cfg, key);
    if (typeof value === "string" && value.length === 0) {
      missing.push(key);
    }
  }
  if (missing.length === 0) {
    return { ok: true };
  }
  return { ok: false, missing, hints: missing.map((k) => HINTS[k]) };
}
