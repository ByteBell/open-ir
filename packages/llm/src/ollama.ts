import { getConfigValue } from "@bb/config";
import { Config } from "@bb/types";
import { LlmConfigError, LlmError } from "@bb/errors";
import { tokenLen } from "./tokenizer.ts";
import type { AskLlmOptions, AskLlmResult } from "./client.ts";

interface OllamaMessage {
  role: "system" | "user";
  content: string;
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  stream: false;
  options?: { temperature?: number };
}

interface OllamaResponse {
  model?: string;
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}${path}`;
}

export function resolveOllamaChain(opts: AskLlmOptions): string[] {
  const url = getConfigValue(Config.OllamaUrl);
  if (url.length === 0) {
    throw new LlmConfigError("plumbline set ollama-url <url>");
  }
  const model = opts.model ?? getConfigValue(Config.OllamaModel);
  if (model.length === 0) {
    throw new LlmConfigError("plumbline set ollama-model <model>");
  }
  return [model];
}

export async function callOllama(prompt: string, opts: AskLlmOptions, timeoutMs: number): Promise<AskLlmResult> {
  const url = getConfigValue(Config.OllamaUrl);
  const chain = resolveOllamaChain(opts);
  const model = chain[0] ?? "";

  const messages: OllamaMessage[] = [];
  if (opts.systemPrompt !== undefined) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const body: OllamaRequest = { model, messages, stream: false };
  if (opts.temperature !== undefined) {
    body.options = { temperature: opts.temperature };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(joinUrl(url, "/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause: unknown) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new LlmError(`Ollama request timed out after ${timeoutMs}ms`, cause);
    }
    throw new LlmError("Ollama request failed", cause);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new LlmError(`Ollama HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as OllamaResponse;
  const content = json.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new LlmError("Ollama returned empty completion");
  }
  return {
    content,
    usage: {
      model: typeof json.model === "string" && json.model.length > 0 ? json.model : model,
      inputTokens:
        typeof json.prompt_eval_count === "number"
          ? json.prompt_eval_count
          : tokenLen((opts.systemPrompt ?? "") + prompt),
      outputTokens: typeof json.eval_count === "number" ? json.eval_count : tokenLen(content),
      costUsd: 0,
    },
  };
}
