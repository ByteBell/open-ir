import { z } from "zod";
import { Config } from "@bb/types";

export { Config };

export const LOG_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LLM_PROVIDERS = ["openrouter", "ollama"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

// The PUBLIC strategies the open-source engine ships. A downstream deployment
// may set `ingestion.strategy` to a private strategy name this list does not
// enumerate, so the stored config value is a free string (validated below).
export const INGESTION_STRATEGIES = ["flat-folder", "concept-graph"] as const;
export type IngestionStrategy = string;

const concurrencySchema = z
  .object({
    github: z.number().int().positive().default(2),
  })
  .strict();

export const configSchema = z
  .object({
    server_port: z.number().int().min(1).max(65535).default(8080),
    neo4j_uri: z.string().default(""),
    neo4j_user: z.string().default(""),
    neo4j_password: z.string().default(""),
    openrouter_api_key: z.string().default(""),
    openrouter_model: z.string().default("deepseek/deepseek-v4-flash"),
    openrouter_fallback_model_1: z.string().default("qwen/qwen3.5-flash-02-23"),
    openrouter_fallback_model_2: z.string().default("minimax/minimax-m2.7"),
    openrouter_fallback_model_3: z.string().default("moonshotai/kimi-k2.5"),
    openrouter_fallback_model_4: z.string().default("x-ai/grok-4.3"),
    concurrency: concurrencySchema.default({ github: 2 }),
    log_level: z.enum(LOG_LEVELS).default("info"),
    log_retention_days: z.number().int().positive().default(14),
    llm_cache_enabled: z.boolean().default(true),
    llm_provider: z.enum(LLM_PROVIDERS).default("openrouter"),
    ollama_url: z.string().default("http://localhost:11434"),
    ollama_model: z.string().default(""),
    "context.window.limit": z.number().int().positive().default(15000),
    "max.tokens.per.chunk": z.number().int().positive().default(6000),
    "big.file.concurrency": z.number().int().positive().default(25),
    "absolute.file.size.cap": z.number().int().positive().default(52428800),
    "concurrent.workers": z.number().int().positive().default(4),
    "llm.concurrency": z.number().int().positive().default(29),
    "folder.summary.batch.size": z.number().int().positive().default(10),
    "folder.summary.batch.max.files": z.number().int().positive().default(15),
    "neo4j.batch.size": z.number().int().positive().default(50),
    "condense.context.limit": z.number().int().positive().default(12000),
    "condense.prompt.overhead": z.number().int().nonnegative().default(1500),
    "small.file.dedup.threshold": z.number().int().positive().default(3),
    "big.file.line.threshold": z.number().int().positive().default(2000),
    org_id: z.string().default("local"),
    "skip.decision.enabled": z.boolean().default(true),
    "skip.decision.max.chars.for.llm": z.number().int().positive().default(4000),
    "skip.decision.cache.path": z.string().default(""),
    // `mongo` was the document store before SQLite replaced it. A config.json
    // written by an older build still carries it, so it is migrated on read —
    // otherwise the upgrade fails at boot with "Database provider 'mongo' is
    // not registered", which tells the user nothing about what to do.
    db_provider: z
      .string()
      .default("sqlite")
      .transform((value) => (value === "mongo" ? "sqlite" : value)),
    graph_provider: z.string().default("neo4j"),
    // `bullmq` was the queue before Honker-over-SQLite replaced it. Migrated on
    // read for the same reason as `db_provider` above — an older config.json
    // would otherwise fail at boot with "Queue provider 'bullmq' is not registered".
    queue_provider: z
      .string()
      .default("honker")
      .transform((value) => (value === "bullmq" ? "honker" : value)),
    // Relative paths resolve under ~/.plumbline (see `resolveUnderHome`), so this
    // default gives every install a durable queue without a `set` call.
    queue_db_path: z.string().default("queue.db"),
    // Relative paths resolve under ~/.plumbline (see `resolveUnderHome`), so
    // this default gives every install a durable store without a `set` call —
    // including one upgrading from the Mongo-era config, which has no value here.
    sqlite_path: z.string().default("data.sqlite"),
    ladybug_path: z.string().default(""),
    // Free string: the OSS engine routes the public strategies it knows
    // (flat-folder / concept-graph) and lets any other value pass through to a
    // downstream deployment that supplies its own (private) strategy.
    "ingestion.strategy": z.string().default("flat-folder"),
    "units.model": z.string().default(""),
    "enrichment.model": z.string().default(""),
    "enrichment.max.tool.calls.per.file": z.number().int().positive().default(15),
    "enrichment.max.iterations.per.file": z.number().int().positive().default(8),
    "enrichment.wall.time.ms.per.file": z.number().int().positive().default(400000),
    "enrichment.concurrency": z.number().int().positive().default(16),
    "enrichment.max.tool.result.chars": z.number().int().positive().default(20000),
    // Reasoning + total-output caps for OpenRouter. Default 0 = omit (provider default, uncapped) so
    // OSS standalone is unchanged; a deployment sets these to bound a reasoning model's thinking/output.
    "openrouter.reasoning.max.tokens": z.number().int().nonnegative().default(0),
    "openrouter.max.completion.tokens": z.number().int().nonnegative().default(0),
  })
  .strict();

export type PlumblineConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: PlumblineConfig = configSchema.parse({});

/**
 * Keys a past release wrote into `config.json` and this build no longer
 * defines. The schema is `.strict()`, so leaving one in place would turn every
 * upgrade into an "Unrecognized key" crash on the first config read. They are
 * dropped on parse and rewritten out of the file by `ensurePlumblineHome`.
 */
export const RETIRED_KEYS: readonly string[] = ["mongo_uri", "redis_url"];

/** True when a stored config still carries a key this build has retired. */
export function hasRetiredKeys(raw: Record<string, unknown>): boolean {
  return RETIRED_KEYS.some((key) => key in raw);
}

/**
 * Parse a stored config, tolerating keys retired by a past release. Use this
 * for anything read off disk or supplied by a host; `configSchema.parse` stays
 * the strict form for values this build constructed itself.
 */
export function parseConfig(value: unknown): PlumblineConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return configSchema.parse(value);
  }
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of RETIRED_KEYS) {
    delete copy[key];
  }
  return configSchema.parse(copy);
}

export type ConfigValueMap = {
  [Config.ServerPort]: number;
  [Config.Neo4jUri]: string;
  [Config.Neo4jUser]: string;
  [Config.Neo4jPassword]: string;
  [Config.OpenrouterApiKey]: string;
  [Config.OpenrouterModel]: string;
  [Config.OpenrouterFallbackModel1]: string;
  [Config.OpenrouterFallbackModel2]: string;
  [Config.OpenrouterFallbackModel3]: string;
  [Config.OpenrouterFallbackModel4]: string;
  [Config.ConcurrencyGithub]: number;
  [Config.LogLevel]: LogLevel;
  [Config.LogRetentionDays]: number;
  [Config.LlmCacheEnabled]: boolean;
  [Config.LlmProvider]: LlmProvider;
  [Config.OllamaUrl]: string;
  [Config.OllamaModel]: string;
  [Config.ContextWindowLimit]: number;
  [Config.MaxTokensPerChunk]: number;
  [Config.BigFileConcurrency]: number;
  [Config.AbsoluteFileSizeCap]: number;
  [Config.ConcurrentWorkers]: number;
  [Config.LlmConcurrency]: number;
  [Config.FolderSummaryBatchSize]: number;
  [Config.FolderSummaryBatchMaxFiles]: number;
  [Config.Neo4jBatchSize]: number;
  [Config.CondenseContextLimit]: number;
  [Config.CondensePromptOverhead]: number;
  [Config.SmallFileDedupThreshold]: number;
  [Config.BigFileLineThreshold]: number;
  [Config.OrgId]: string;
  [Config.SkipDecisionEnabled]: boolean;
  [Config.SkipDecisionMaxCharsForLlm]: number;
  [Config.SkipDecisionCachePath]: string;
  [Config.DbProvider]: string;
  [Config.GraphProvider]: string;
  [Config.QueueProvider]: string;
  [Config.QueueDbPath]: string;
  [Config.SqlitePath]: string;
  [Config.LadybugPath]: string;
  [Config.IngestionStrategy]: IngestionStrategy;
  [Config.UnitsModel]: string;
  [Config.EnrichmentModel]: string;
  [Config.EnrichmentMaxToolCallsPerFile]: number;
  [Config.EnrichmentMaxIterationsPerFile]: number;
  [Config.EnrichmentWallTimeMsPerFile]: number;
  [Config.EnrichmentConcurrency]: number;
  [Config.EnrichmentMaxToolResultChars]: number;
  [Config.OpenrouterReasoningMaxTokens]: number;
  [Config.OpenrouterMaxCompletionTokens]: number;
};

export type ConfigValue<K extends Config> = ConfigValueMap[K];

export const REQUIRED_KEYS: readonly Config[] = [Config.Neo4jUri, Config.Neo4jUser, Config.Neo4jPassword];

const PROVIDER_REQUIRED_KEYS: Readonly<Record<LlmProvider, readonly Config[]>> = {
  openrouter: [Config.OpenrouterApiKey],
  ollama: [Config.OllamaUrl, Config.OllamaModel],
};

export function requiredKeysFor(provider: LlmProvider): readonly Config[] {
  return [...REQUIRED_KEYS, ...PROVIDER_REQUIRED_KEYS[provider]];
}

export const HINTS: Readonly<Record<Config, string>> = {
  [Config.ServerPort]: "plumbline set port <n>",
  [Config.Neo4jUri]: "plumbline set neo4j <uri>",
  [Config.Neo4jUser]: "plumbline set neo4j-user <user>",
  [Config.Neo4jPassword]: "plumbline set neo4j-password <pwd>",
  [Config.OpenrouterApiKey]: "plumbline keys set",
  [Config.OpenrouterModel]: "plumbline models set <model-id>",
  [Config.OpenrouterFallbackModel1]: "plumbline set openrouter-fallback-model-1 <model-id>",
  [Config.OpenrouterFallbackModel2]: "plumbline set openrouter-fallback-model-2 <model-id>",
  [Config.OpenrouterFallbackModel3]: "plumbline set openrouter-fallback-model-3 <model-id>",
  [Config.OpenrouterFallbackModel4]: "plumbline set openrouter-fallback-model-4 <model-id>",
  [Config.ConcurrencyGithub]: "plumbline set concurrency.github <n>",
  [Config.LogLevel]: "plumbline set log-level <error|warn|info|debug>",
  [Config.LogRetentionDays]: "plumbline set log-retention-days <n>",
  [Config.LlmCacheEnabled]: "plumbline set llm_cache_enabled <true|false>",
  [Config.LlmProvider]: "plumbline set llm-provider <openrouter|ollama>",
  [Config.OllamaUrl]: "plumbline set ollama-url <url>",
  [Config.OllamaModel]: "plumbline set ollama-model <model>",
  [Config.ContextWindowLimit]: "plumbline set context.window.limit <n>",
  [Config.MaxTokensPerChunk]: "plumbline set max.tokens.per.chunk <n>",
  [Config.BigFileConcurrency]: "plumbline set big.file.concurrency <n>",
  [Config.AbsoluteFileSizeCap]: "plumbline set absolute.file.size.cap <bytes>",
  [Config.ConcurrentWorkers]: "plumbline set concurrent.workers <n>",
  [Config.LlmConcurrency]: "plumbline set llm.concurrency <n>",
  [Config.FolderSummaryBatchSize]: "plumbline set folder.summary.batch.size <n>",
  [Config.FolderSummaryBatchMaxFiles]: "plumbline set folder.summary.batch.max.files <n>",
  [Config.Neo4jBatchSize]: "plumbline set neo4j.batch.size <n>",
  [Config.CondenseContextLimit]: "plumbline set condense.context.limit <n>",
  [Config.CondensePromptOverhead]: "plumbline set condense.prompt.overhead <n>",
  [Config.SmallFileDedupThreshold]: "plumbline set small.file.dedup.threshold <n>",
  [Config.BigFileLineThreshold]: "plumbline set big.file.line.threshold <n>",
  [Config.OrgId]: "plumbline set org_id <value>",
  [Config.SkipDecisionEnabled]: "plumbline set skip.decision.enabled <true|false>",
  [Config.SkipDecisionMaxCharsForLlm]: "plumbline set skip.decision.max.chars.for.llm <n>",
  [Config.SkipDecisionCachePath]: "plumbline set skip.decision.cache.path <path>",
  [Config.DbProvider]: "plumbline set db-provider <sqlite>",
  [Config.GraphProvider]: "plumbline set graph-provider <neo4j|...>",
  [Config.QueueProvider]: "plumbline set queue-provider <honker>",
  [Config.QueueDbPath]: "plumbline set queue-db-path <path>",
  [Config.SqlitePath]: "plumbline set sqlite-path <path>",
  [Config.LadybugPath]: "plumbline set ladybug-path <path>",
  [Config.IngestionStrategy]: "plumbline set ingestion.strategy <flat-folder|concept-graph>",
  [Config.UnitsModel]: "plumbline set units.model <model-id>",
  [Config.EnrichmentModel]: "plumbline set enrichment.model <model-id>",
  [Config.EnrichmentMaxToolCallsPerFile]: "plumbline set enrichment.max.tool.calls.per.file <n>",
  [Config.EnrichmentMaxIterationsPerFile]: "plumbline set enrichment.max.iterations.per.file <n>",
  [Config.EnrichmentWallTimeMsPerFile]: "plumbline set enrichment.wall.time.ms.per.file <ms>",
  [Config.EnrichmentConcurrency]: "plumbline set enrichment.concurrency <n>",
  [Config.EnrichmentMaxToolResultChars]: "plumbline set enrichment.max.tool.result.chars <n>",
  [Config.OpenrouterReasoningMaxTokens]: "plumbline set openrouter.reasoning.max.tokens <n>",
  [Config.OpenrouterMaxCompletionTokens]: "plumbline set openrouter.max.completion.tokens <n>",
};

export { readField, writeField } from "./schema-fields.ts";
