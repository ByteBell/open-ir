export enum Config {
  ServerPort = "server_port",
  Neo4jUri = "neo4j_uri",
  Neo4jUser = "neo4j_user",
  Neo4jPassword = "neo4j_password",
  OpenrouterApiKey = "openrouter_api_key",
  OpenrouterModel = "openrouter_model",
  OpenrouterFallbackModel1 = "openrouter_fallback_model_1",
  OpenrouterFallbackModel2 = "openrouter_fallback_model_2",
  OpenrouterFallbackModel3 = "openrouter_fallback_model_3",
  OpenrouterFallbackModel4 = "openrouter_fallback_model_4",
  ConcurrencyGithub = "concurrency.github",
  LogLevel = "log_level",
  LogRetentionDays = "log_retention_days",
  LlmCacheEnabled = "llm_cache_enabled",
  LlmProvider = "llm_provider",
  OllamaUrl = "ollama_url",
  OllamaModel = "ollama_model",
  ContextWindowLimit = "context.window.limit",
  MaxTokensPerChunk = "max.tokens.per.chunk",
  BigFileConcurrency = "big.file.concurrency",
  AbsoluteFileSizeCap = "absolute.file.size.cap",
  ConcurrentWorkers = "concurrent.workers",
  LlmConcurrency = "llm.concurrency",
  FolderSummaryBatchSize = "folder.summary.batch.size",
  FolderSummaryBatchMaxFiles = "folder.summary.batch.max.files",
  Neo4jBatchSize = "neo4j.batch.size",
  CondenseContextLimit = "condense.context.limit",
  CondensePromptOverhead = "condense.prompt.overhead",
  SmallFileDedupThreshold = "small.file.dedup.threshold",
  BigFileLineThreshold = "big.file.line.threshold",
  OrgId = "org_id",
  SkipDecisionEnabled = "skip.decision.enabled",
  SkipDecisionMaxCharsForLlm = "skip.decision.max.chars.for.llm",
  SkipDecisionCachePath = "skip.decision.cache.path",
  DbProvider = "db_provider",
  GraphProvider = "graph_provider",
  QueueProvider = "queue_provider",
  QueueDbPath = "queue_db_path",
  SqlitePath = "sqlite_path",
  LadybugPath = "ladybug_path",
  IngestionStrategy = "ingestion.strategy",
  /**
   * Optional model for a fine-grained, high-volume per-unit analysis pass. When set, the
   * runner routes per-unit calls to this model instead of `openrouter_model`, letting a deployment
   * point the high-volume per-unit pass at a cheaper model. Empty → per-unit uses the main model.
   */
  UnitsModel = "units.model",
  EnrichmentModel = "enrichment.model",
  EnrichmentMaxToolCallsPerFile = "enrichment.max.tool.calls.per.file",
  EnrichmentMaxIterationsPerFile = "enrichment.max.iterations.per.file",
  EnrichmentWallTimeMsPerFile = "enrichment.wall.time.ms.per.file",
  EnrichmentConcurrency = "enrichment.concurrency",
  EnrichmentMaxToolResultChars = "enrichment.max.tool.result.chars",
  /**
   * Per-call reasoning ("thinking") token budget sent to OpenRouter as `reasoning.max_tokens`.
   * Bounds how long a reasoning model (e.g. minimax-m3) thinks. 0 → omit (provider default, uncapped).
   */
  OpenrouterReasoningMaxTokens = "openrouter.reasoning.max.tokens",
  /**
   * Per-call hard ceiling on total completion tokens sent to OpenRouter as `max_tokens` (reasoning +
   * visible). 0 → omit (provider default, uncapped).
   */
  OpenrouterMaxCompletionTokens = "openrouter.max.completion.tokens",
}

export enum DbProviderType {
  Sqlite = "sqlite",
}

export enum GraphProviderType {
  Neo4j = "neo4j",
  Ladybug = "ladybug",
}

export enum QueueProviderType {
  Honker = "honker",
}
/**
 * The PUBLIC ingestion strategies. `flat-folder` is the historic default that
 * produces `:Repo` + `:Folder` summaries via per-folder LLM passes.
 * `concept-graph` drops folder/repo summaries and runs a per-file
 * MCP-driven enrichment pass that emits `:Concept` / `:Contract` /
 * `:Guidepost` nodes instead.
 *
 * This enum lists only the strategies the open-source engine ships. The
 * `ingestion.strategy` config value is a free string, so a downstream
 * deployment may select a strategy this enum does not enumerate.
 */
export enum IngestionStrategyType {
  FlatFolder = "flat-folder",
  ConceptGraph = "concept-graph",
}
