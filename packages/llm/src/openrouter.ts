import { getConfigValue } from "@bb/config";
import { Config } from "@bb/types";
import { LlmConfigError, LlmError } from "@bb/errors";
import type { AskLlmOptions, AskLlmResult } from "./client.ts";
import { openRouterRawChat, type OpenRouterMessageInput } from "./openrouterChat.ts";

export function resolveOpenRouterChain(opts: AskLlmOptions): string[] {
  const apiKey = opts.apiKey ?? getConfigValue(Config.OpenrouterApiKey);
  if (apiKey.length === 0) {
    throw new LlmConfigError("plumbline keys set");
  }
  const model = opts.model ?? getConfigValue(Config.OpenrouterModel);
  const fallbackSlots = opts.fallbackModels ?? [
    getConfigValue(Config.OpenrouterFallbackModel1),
    getConfigValue(Config.OpenrouterFallbackModel2),
    getConfigValue(Config.OpenrouterFallbackModel3),
    getConfigValue(Config.OpenrouterFallbackModel4),
  ];
  const chain = [model, ...fallbackSlots].filter((m) => m.length > 0);
  // OpenRouter rejects `models: [...]` arrays with more than 3 entries (HTTP 400
  // "models array must have 3 items or fewer"). Cap the deduped chain at 3.
  return [...new Set(chain)].slice(0, 3);
}

export async function callOpenRouter(prompt: string, opts: AskLlmOptions, timeoutMs: number): Promise<AskLlmResult> {
  const cappedChain = resolveOpenRouterChain(opts);
  const messages: OpenRouterMessageInput[] = [];
  if (opts.systemPrompt !== undefined) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: prompt });
  const result = await openRouterRawChat(messages, cappedChain, opts, timeoutMs);
  const content = result.message.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new LlmError("OpenRouter returned empty completion");
  }
  return { content, usage: result.usage };
}
