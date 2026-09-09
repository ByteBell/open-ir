#!/usr/bin/env bun
/**
 * One-shot probe: does the configured ENRICHMENT_MODEL emit `tool_calls`
 * when `tool_choice: "required"` is set? Bypasses the document store / Neo4j entirely
 * — just exercises the OpenRouter request shape so we can confirm the
 * model actually honors the constraint before running a full enrichment.
 *
 * Run with the parent repo's .env:
 *   bun --env-file=/Users/deadbytes/Documents/ByteBell/Ingestion-engine/.env \
 *       ext/ingestion-engine-public/scripts/test-tool-choice.ts
 */
import { seedConfig } from "@bb/config";
import { askLLMWithTools, type ToolDefinition } from "@bb/llm";

const apiKey = process.env["OPENROUTER_API_KEY"];
const model = process.env["ENRICHMENT_MODEL"] ?? process.env["OPENROUTER_MODEL_NAME"];

if (apiKey === undefined || apiKey.length === 0) {
  process.stderr.write("OPENROUTER_API_KEY not set in env — pass --env-file=…/.env\n");
  process.exit(1);
}
if (model === undefined || model.length === 0) {
  process.stderr.write("ENRICHMENT_MODEL (or OPENROUTER_MODEL_NAME) not set in env\n");
  process.exit(1);
}

// Minimum config to satisfy `@bb/config` invariants — schema validates and
// rejects unknown keys, so we provide a full-shaped object.
seedConfig({
  server_port: 8080,
  neo4j_uri: "bolt://placeholder:7687",
  neo4j_user: "placeholder",
  neo4j_password: "placeholder",
  openrouter_api_key: apiKey,
  openrouter_model: model,
  openrouter_fallback_model_1: "",
  openrouter_fallback_model_2: "",
  openrouter_fallback_model_3: "",
  openrouter_fallback_model_4: "",
  log_level: "info",
  log_retention_days: 7,
  llm_cache_enabled: false,
  llm_provider: "openrouter",
  ollama_url: "http://localhost:11434",
  ollama_model: "",
  "context.window.limit": 15000,
  "max.tokens.per.chunk": 6000,
  "big.file.concurrency": 25,
  "absolute.file.size.cap": 52_428_800,
  "concurrent.workers": 4,
  "llm.concurrency": 29,
  "folder.summary.batch.size": 10,
  "folder.summary.batch.max.files": 15,
  "neo4j.batch.size": 50,
  "condense.context.limit": 12000,
  "condense.prompt.overhead": 1500,
  "small.file.dedup.threshold": 3,
  "big.file.line.threshold": 2000,
  org_id: "local",
  "skip.decision.enabled": false,
  "skip.decision.max.chars.for.llm": 4000,
  "skip.decision.cache.path": "",
  db_provider: "sqlite",
  graph_provider: "neo4j",
  sqlite_path: "",
  concurrency: { github: 2 },
  "ingestion.strategy": "concept-graph",
  "enrichment.model": model,
  "enrichment.max.tool.calls.per.file": 15,
  "enrichment.max.iterations.per.file": 8,
  "enrichment.wall.time.ms.per.file": 400_000,
  "enrichment.concurrency": 16,
  "enrichment.max.tool.result.chars": 20_000,
});

// Trivial tool catalog — the LLM doesn't need to do anything useful with
// these, just demonstrate that `tool_choice: "required"` forces it to emit
// at least one tool_call block.
const tools: ToolDefinition[] = [
  {
    name: "smart_search",
    description: "Search the knowledge graph for files matching a term. Returns top-K results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term" },
      },
      required: ["query"],
    },
  },
  {
    name: "keyword_lookup",
    description: "Find files attached to a named entity.",
    parameters: {
      type: "object",
      properties: {
        term: { type: "string", description: "Entity name" },
      },
      required: ["term"],
    },
  },
];

const executeTool = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
  process.stdout.write(`\n  → TOOL CALL: ${name}(${JSON.stringify(input)})\n`);
  // Echo back a tiny canned result so the loop can terminate after one call.
  return { results: [{ note: "stub response from test script" }] };
};

process.stdout.write(`\n[probe] model=${model}\n`);
process.stdout.write(`[probe] calling askLLMWithTools with tool_choice:"required" on turn 1…\n\n`);

const startedAt = Date.now();
try {
  const result = await askLLMWithTools({
    prompt:
      "Briefly summarise the role of a file named `wallet-controller.ts` in a typical web backend. " +
      'Emit a one-line JSON like {"summary":"..."} as your final answer.',
    systemPrompt:
      "You are testing the tool-use loop. You MUST call at least one of the provided tools " +
      "before emitting your final answer. After the tool result comes back, emit the JSON.",
    tools,
    executeTool,
    model,
    apiKey,
    maxIterations: 4,
    maxToolCalls: 3,
    wallTimeMs: 120_000,
    maxToolResultChars: 4000,
  });

  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(`\n[probe] terminated: ${result.terminationReason}\n`);
  process.stdout.write(`[probe] iterations: ${result.iterations}\n`);
  process.stdout.write(`[probe] toolCalls: ${result.toolCalls.length}\n`);
  process.stdout.write(`[probe] model OpenRouter routed to: ${result.usage.model}\n`);
  process.stdout.write(
    `[probe] tokens: in=${result.usage.inputTokens} out=${result.usage.outputTokens} cost=$${result.usage.costUsd}\n`,
  );
  process.stdout.write(`[probe] wall: ${elapsedMs}ms\n`);
  process.stdout.write(`[probe] final content: ${result.content}\n\n`);

  if (result.toolCalls.length === 0) {
    process.stderr.write('❌ FAIL: zero tool calls — model ignored tool_choice:"required"\n');
    process.exit(2);
  }
  process.stdout.write('✅ PASS: model honored tool_choice:"required" — emitted at least one tool call\n');
} catch (cause: unknown) {
  process.stderr.write(`\n[probe] ERROR: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  if (cause instanceof Error && cause.stack !== undefined) {
    process.stderr.write(`${cause.stack}\n`);
  }
  process.exit(3);
}
