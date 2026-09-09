# `@bb/llm/src` — context

Implementation of `@bb/llm`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

## Files

- **[index.ts](index.ts)** — public re-exports. The only entry point other
  packages may import. Exposes `askLLM`, the `AskLlmOptions` type, the
  `LlmProviderName` union (`"openrouter" | "ollama"`), plus the JSON
  client surface. Anything not re-exported here is internal.
- **[client.ts](client.ts)** — the `askLLM` orchestrator. Selects the
  active provider via `opts.provider ?? getConfigValue(Config.LlmProvider)`
  (per-call override beats config), dispatches to `openrouter.ts` or
  `ollama.ts`. Consults the filesystem decision cache before issuing a
  request. Throws typed errors via `@bb/errors`.
- **[openrouter.ts](openrouter.ts)** — `callOpenRouter` and
  `resolveOpenRouterChain`. Resolves the API key (`opts.apiKey
?? getConfigValue(Config.OpenrouterApiKey)`) and the model chain
  (capped at 3 entries — OpenRouter's hard limit). Delegates the HTTP
  request to `openRouterRawChat` in `openrouterChat.ts`. Returns the
  first choice's content as a plain `{ content, usage }` pair. Throws
  `LlmConfigError` if the key is empty and `LlmError` on timeout /
  non-2xx / empty completion.
- **[openrouterChat.ts](openrouterChat.ts)** — `openRouterRawChat`:
  lower-level POST to the chat-completions endpoint that accepts
  arbitrary `messages[]` (including `assistant` with `tool_calls` and
  `tool` results) and an optional `tools[]` list. Returns the full
  assistant message so callers can dispatch on `tool_calls`. Always
  sends `provider: { allow_fallbacks: false }` (OpenRouter cannot
  silently route across upstream providers) and `usage: { include: true }`
  (authoritative billed cost in the response). Consumed by
  `callOpenRouter` (single-shot wrapper) and `toolLoop.ts`.
- **[toolLoop.ts](toolLoop.ts)** — `askLLMWithTools`: multi-turn
  tool-use driver. Builds initial messages from `prompt` + optional
  `systemPrompt`, calls `openRouterRawChat` with the caller's
  `tools[]`, and loops on `tool_calls` until the model returns a
  terminal text turn or a cap fires. Caps: `maxIterations`,
  `maxToolCalls`, `wallTimeMs` (global) and `perRequestTimeoutMs`
  (per request, capped at remaining wall-time). Per-result strings are
  truncated to `maxToolResultChars` (default 20000) before being fed
  back to the model. Provider scope is OpenRouter only — Ollama is
  rejected at the entrypoint because OpenAI-tool-format support varies
  across open models. Cumulative `usage` (input + output tokens, cost)
  is summed across every iteration.
- **[toolTypes.ts](toolTypes.ts)** — `ToolDefinition`, `ToolInvocation`,
  `LoopTerminationReason` (`completed | max-iterations | max-tool-calls
| wall-time-exceeded | empty-response`), `AskLLMWithToolsOptions`,
  `AskLLMWithToolsResult`.
- **[ollama.ts](ollama.ts)** — `callOllama` and `resolveOllamaChain`.
  Single-model per request (Ollama has no fan-out). Reads model from
  `opts.model ?? Config.OllamaModel`. Ignores `opts.apiKey` (Ollama is
  keyless).
- **[jsonClient.ts](jsonClient.ts)** — `askJsonLLM`, `askYesNoLLM`,
  `tryParseJson`, `stripJsonFence`. Wraps `askLLM` with JSON-strict
  retry logic. Forwards `opts` (including `apiKey` / `provider` / `model`)
  to `askLLM` unchanged.
- **[cache.ts](cache.ts)** — filesystem-backed decision cache. Key
  includes `provider` and `modelChain`; `opts.apiKey` is intentionally
  NOT part of the key (the cached decision is the same regardless of
  which key produced it — keys are auth, not semantic input).
- **[tokenizer.ts](tokenizer.ts)** — `tokenLen`, `encodeTokens`,
  `decodeTokens`. Module-cached `tiktoken` encoder using `cl100k_base`,
  lazy-initialized via `get_encoding`. All three helpers fall back to
  char/4 (`tokenLen`) or empty result (`encodeTokens` / `decodeTokens`)
  if the WASM init fails — pipeline keeps running even on exotic Bun
  builds.
- **[pricing.ts](pricing.ts)** — `estimateCostUsd` and
  `estimateCostFromBreakdown`. One-shot fetch of OpenRouter's
  `/api/v1/models` (cached for the process lifetime).

## Module dependency graph

```
client.ts    → @bb/config (getConfigValue), @bb/types (Config),
               @bb/errors (LlmConfigError, LlmError)
               (built-in: fetch, AbortController, setTimeout)
tokenizer.ts → tiktoken (npm: get_encoding, Tiktoken type)
pricing.ts   → @bb/config, @bb/types
index.ts     → re-exports the public surface from client.ts,
               tokenizer.ts, pricing.ts
```

No cycles. Each implementation file owns one concern (HTTP, tokens,
pricing).

## Invariants enforced here

- **No module state.** `askLLM` constructs a fresh request per call; no
  caching, no shared client, no memoization. Tests need no reset hook.
- **Timeout is honored.** AbortController fires at `timeoutMs`; the
  `clearTimeout` call lives in a `finally` so the timer is always
  cleared regardless of fetch outcome.
- **Errors carry typed metadata.** `LlmConfigError` carries the
  `plumbline keys set` hint; `LlmError` accepts an optional `cause` and
  composes a single-line message capped at 500 chars of any HTTP error
  body (so the logger doesn't blow up on multi-MB error responses).
- **No env reads.** Secrets come from `opts.apiKey` first, then
  `getConfigValue(Config.OpenrouterApiKey)`. Same fallback shape for the
  provider switch via `opts.provider` → `Config.LlmProvider`.
- **Empty completions are errors.** A 200 OK with no `choices[0].message
.content` throws `LlmError("OpenRouter returned empty completion")` —
  do not silently return an empty string.

## Adding a helper

Follow the recipes in [../README.md](../README.md) under _How to
extend_. New files live as flat `src/<name>.ts` (the repo ESLint rule
forbids parent traversal — keep `src/` flat).
