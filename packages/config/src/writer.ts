import fs from "node:fs";
import {
  configSchema,
  parseConfig,
  hasRetiredKeys,
  Config,
  type PlumblineConfig,
  type ConfigValue,
  DEFAULT_CONFIG,
  writeField,
} from "./schema.ts";
import { __isSeeded } from "./loader.ts";
import { getPlumblineHome, getConfigPath, __notifyConfigChanged } from "./paths.ts";

export class ConfigSeededError extends Error {
  constructor() {
    super("config cache is seeded; setConfigValue is disabled");
    this.name = "ConfigSeededError";
  }
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function readConfigFile(): PlumblineConfig {
  const raw = fs.readFileSync(getConfigPath(), "utf8");
  const parsed: unknown = JSON.parse(raw);
  return parseConfig(parsed);
}

function atomicWrite(cfg: PlumblineConfig): void {
  const target = getConfigPath();
  const tmp = `${target}.tmp`;
  const json = `${JSON.stringify(cfg, null, 2)}\n`;
  const fd = fs.openSync(tmp, "w", FILE_MODE);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

export function ensurePlumblineHome(): void {
  const home = getPlumblineHome();
  fs.mkdirSync(home, { recursive: true, mode: DIR_MODE });
  if (!fs.existsSync(getConfigPath())) {
    atomicWrite(DEFAULT_CONFIG);
    return;
  }
  const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
  // Rewrite when the file is missing a key this build added, or still carries
  // one it retired — either way the on-disk shape is brought up to date.
  const expected = Object.keys(configSchema.shape);
  if (expected.some((k) => !(k in raw)) || hasRetiredKeys(raw)) {
    atomicWrite(parseConfig(raw));
    __notifyConfigChanged();
  }
}

export function setConfigValue<K extends Config>(key: K, value: ConfigValue<K>): void {
  if (__isSeeded()) {
    throw new ConfigSeededError();
  }
  ensurePlumblineHome();
  const current = readConfigFile();
  const next = writeField(current, key, value);
  configSchema.parse(next);
  atomicWrite(next);
  __notifyConfigChanged();
}
