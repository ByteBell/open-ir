import { LLM_PROVIDERS, LOG_LEVELS, setConfigValue, type LlmProvider, type LogLevel } from "@bb/config";
import { Config, DbProviderType, GraphProviderType, IngestionStrategyType, QueueProviderType } from "@bb/types";

type Setter = (raw: string) => void;

export interface KeyEntry {
  configKey: Config;
  redact: boolean;
  setter: Setter;
  /**
   * For two-value enum keys (e.g. provider toggles): the allowed pair. When
   * `plumbline set <key>` is run with no value, the CLI flips to the other one.
   */
  toggleValues?: readonly [string, string];
}

function parsePositiveInt(raw: string, key: string): number {
  if (!/^-?\d+$/u.test(raw)) {
    throw new Error(`Invalid value for "${key}": expected an integer, got "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  if (n <= 0) {
    throw new Error(`Invalid value for "${key}": expected a positive integer, got ${n}`);
  }
  return n;
}

function parsePort(raw: string): number {
  const n = parsePositiveInt(raw, "port");
  if (n > 65535) {
    throw new Error(`Invalid value for "port": ${n} is above 65535`);
  }
  return n;
}

function parseLogLevel(raw: string): LogLevel {
  const allowed: readonly string[] = LOG_LEVELS;
  if (!allowed.includes(raw)) {
    throw new Error(`Invalid value for "log-level": expected one of ${LOG_LEVELS.join(", ")}, got "${raw}"`);
  }
  return raw as LogLevel;
}

function parseLlmProvider(raw: string): LlmProvider {
  const allowed: readonly string[] = LLM_PROVIDERS;
  if (!allowed.includes(raw)) {
    throw new Error(`Invalid value for "llm-provider": expected one of ${LLM_PROVIDERS.join(", ")}, got "${raw}"`);
  }
  return raw as LlmProvider;
}

function parseEnum(raw: string, key: string, allowed: readonly string[]): string {
  if (!allowed.includes(raw)) {
    throw new Error(`Invalid value for "${key}": expected one of ${allowed.join(", ")}, got "${raw}"`);
  }
  return raw;
}

const DB_PROVIDERS: readonly string[] = Object.values(DbProviderType);
const GRAPH_PROVIDERS: readonly string[] = Object.values(GraphProviderType);
const INGESTION_STRATEGIES: readonly string[] = Object.values(IngestionStrategyType);
const QUEUE_PROVIDERS: readonly string[] = Object.values(QueueProviderType);

function parseBoolean(raw: string, key: string): boolean {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`Invalid value for "${key}": expected "true" or "false", got "${raw}"`);
}

export const KEY_MAP: Record<string, KeyEntry> = {
  neo4j: {
    configKey: Config.Neo4jUri,
    redact: false,
    setter: (s) => setConfigValue(Config.Neo4jUri, s),
  },
  "neo4j-user": {
    configKey: Config.Neo4jUser,
    redact: false,
    setter: (s) => setConfigValue(Config.Neo4jUser, s),
  },
  "neo4j-password": {
    configKey: Config.Neo4jPassword,
    redact: true,
    setter: (s) => setConfigValue(Config.Neo4jPassword, s),
  },
  port: {
    configKey: Config.ServerPort,
    redact: false,
    setter: (s) => setConfigValue(Config.ServerPort, parsePort(s)),
  },
  "log-level": {
    configKey: Config.LogLevel,
    redact: false,
    setter: (s) => setConfigValue(Config.LogLevel, parseLogLevel(s)),
  },
  "log-retention-days": {
    configKey: Config.LogRetentionDays,
    redact: false,
    setter: (s) => setConfigValue(Config.LogRetentionDays, parsePositiveInt(s, "log-retention-days")),
  },
  "concurrency.github": {
    configKey: Config.ConcurrencyGithub,
    redact: false,
    setter: (s) => setConfigValue(Config.ConcurrencyGithub, parsePositiveInt(s, "concurrency.github")),
  },
  "openrouter-api-key": {
    configKey: Config.OpenrouterApiKey,
    redact: true,
    setter: (s) => setConfigValue(Config.OpenrouterApiKey, s),
  },
  "openrouter-model": {
    configKey: Config.OpenrouterModel,
    redact: false,
    setter: (s) => setConfigValue(Config.OpenrouterModel, s),
  },
  "openrouter-fallback-model-1": {
    configKey: Config.OpenrouterFallbackModel1,
    redact: false,
    setter: (s) => setConfigValue(Config.OpenrouterFallbackModel1, s),
  },
  "openrouter-fallback-model-2": {
    configKey: Config.OpenrouterFallbackModel2,
    redact: false,
    setter: (s) => setConfigValue(Config.OpenrouterFallbackModel2, s),
  },
  "openrouter-fallback-model-3": {
    configKey: Config.OpenrouterFallbackModel3,
    redact: false,
    setter: (s) => setConfigValue(Config.OpenrouterFallbackModel3, s),
  },
  "openrouter-fallback-model-4": {
    configKey: Config.OpenrouterFallbackModel4,
    redact: false,
    setter: (s) => setConfigValue(Config.OpenrouterFallbackModel4, s),
  },
  llm_cache_enabled: {
    configKey: Config.LlmCacheEnabled,
    redact: false,
    setter: (s) => setConfigValue(Config.LlmCacheEnabled, parseBoolean(s, "llm_cache_enabled")),
  },
  "llm-provider": {
    configKey: Config.LlmProvider,
    redact: false,
    setter: (s) => setConfigValue(Config.LlmProvider, parseLlmProvider(s)),
  },
  "ollama-url": {
    configKey: Config.OllamaUrl,
    redact: false,
    setter: (s) => setConfigValue(Config.OllamaUrl, s),
  },
  "ollama-model": {
    configKey: Config.OllamaModel,
    redact: false,
    setter: (s) => setConfigValue(Config.OllamaModel, s),
  },
  "db-provider": {
    configKey: Config.DbProvider,
    redact: false,
    setter: (s) => setConfigValue(Config.DbProvider, parseEnum(s, "db-provider", DB_PROVIDERS)),
  },
  "graph-provider": {
    configKey: Config.GraphProvider,
    redact: false,
    setter: (s) => setConfigValue(Config.GraphProvider, parseEnum(s, "graph-provider", GRAPH_PROVIDERS)),
    toggleValues: [GraphProviderType.Neo4j, GraphProviderType.Ladybug],
  },
  "ingestion-strategy": {
    configKey: Config.IngestionStrategy,
    redact: false,
    setter: (s) =>
      setConfigValue(
        Config.IngestionStrategy,
        parseEnum(s, "ingestion-strategy", INGESTION_STRATEGIES) as IngestionStrategyType,
      ),
    toggleValues: [IngestionStrategyType.FlatFolder, IngestionStrategyType.ConceptGraph],
  },
  "queue-provider": {
    configKey: Config.QueueProvider,
    redact: false,
    setter: (s) => setConfigValue(Config.QueueProvider, parseEnum(s, "queue-provider", QUEUE_PROVIDERS)),
  },
  "queue-db-path": {
    configKey: Config.QueueDbPath,
    redact: false,
    setter: (s) => setConfigValue(Config.QueueDbPath, s),
  },
  "sqlite-path": {
    configKey: Config.SqlitePath,
    redact: false,
    setter: (s) => setConfigValue(Config.SqlitePath, s),
  },
  "ladybug-path": {
    configKey: Config.LadybugPath,
    redact: false,
    setter: (s) => setConfigValue(Config.LadybugPath, s),
  },
};

export function validKeysList(): string[] {
  return Object.keys(KEY_MAP);
}
