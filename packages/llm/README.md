# `@bb/llm` — context

## Tier

Cross-cutting. Depends on Kernel (`@bb/types` for `Config`, `@bb/errors`
for typed error classes) and Infrastructure (`@bb/config` for the
provider switch, OpenRouter key/model, and Ollama URL/model). May be
imported by Domain (`@bb/ingest-*`, `@bb/mcp`, future
`@bb/metadata-optimizer`) and Binaries (`@bb/server`). Never by
`@bb/cli`.

## Responsibility

Minimal multi-provider LLM call surface for v0. The active backend is
selected by `Config.LlmProvider` (`"openrouter"` default, or
`"ollama"`):

- `askLLM(prompt, opts?)` — dispatches to either
  `src/openrouter.ts` or `src/ollama.ts` depending on
  `Config.LlmProvider`. Returns
  `{ content, usage: { model, inputTokens, outputTokens, costUsd } }`.
  Caller never sees the provider; the result shape is identical across
  backends. `costUsd` is the provider-reported USD cost for that single
  call — taken straight from the provider's response, never computed
  client-side.
- **OpenRouter mode** — POST to OpenRouter's chat-completions endpoint
  using `Config.OpenrouterApiKey` + `Config.OpenrouterModel` as the
  primary model, plus `Config.OpenrouterFallbackModel1..4` as the
  fallback chain. The request body includes a `models: [...]` array
  when the deduplicated chain has ≥2 non-empty entries and always sends
  `usage: { include: true }` so OpenRouter populates `usage.cost` in
  the response. The body also pins `provider: { allow_fallbacks: false }`
  so OpenRouter does not silently cycle across upstream providers of the
  same model — a slow or sick provider surfaces a real error to us
  instead of consuming the wall-clock budget. Model-level fallback
  through the `models` chain is unaffected. `usage.model` is the actual
  model the gateway picked. Tokens come straight from OpenRouter's
  `usage.prompt_tokens` / `usage.completion_tokens`; `costUsd` from
  `usage.cost` (defaults to `0` when the provider omits it — common for
  `:free` models).
- **Ollama mode** — POST to `${Config.OllamaUrl}/api/chat` with
  `{ model: Config.OllamaModel, messages, stream: false }`. Single
  model per request — no fallback chain (Ollama does not have a
  multi-model fan-out). The model string is free-form: any model the
  user has pulled into their Ollama daemon works (`llama3.1`,
  `qwen2.5-coder:7b`, custom Modelfile names — we do not validate).
  `inputTokens` ← `prompt_eval_count`, `outputTokens` ← `eval_count`,
  `costUsd` ← `0` (Ollama is keyless / local).
- AbortController-based timeout (default 90s, matches the kube-package
  reference `askLLM` shape)
- Typed errors via `@bb/errors`: `LlmConfigError` (missing key) and
  `LlmError` (HTTP non-2xx, timeout, empty completion)
- `tokenLen(text)`, `encodeTokens(text)`, `decodeTokens(tokens)` —
  thin wrappers over `tiktoken` (`cl100k_base` encoding). Lazy-cached
  encoder at module scope; char/4 fallback only fires on tokenizer
  init failure. Used by `@bb/ingest-github` for chunk sizing,
  routing, and condense-prompt budgeting.

`askLLMWithTools` drives an OpenRouter-routed model through a multi-turn
`tool_use` / `tool_result` loop until the model emits a terminal
assistant message. The caller supplies `tools: ToolDefinition[]` (name +
description + JSON Schema parameters) and an async `executeTool(name,
input)` callback the loop invokes for each tool the model picks. The
loop caps every dimension: `maxIterations` (LLM round-trips),
`maxToolCalls` (cumulative tool invocations), `wallTimeMs` (total
clock), `maxToolResultChars` (per-result truncation before the result
is fed back to the model). When a cap fires before the model returns
text, the result carries `terminationReason: "max-iterations" |
"max-tool-calls" | "wall-time-exceeded"` and empty `content`; callers
decide whether to fail loud. Provider HTTP failures still propagate as
`LlmError`. Tool-use is **OpenRouter only** — the Ollama path stays
single-shot since open models behind Ollama vary in OpenAI-tool-format
support; the caller is responsible for picking a tool-capable model.

Local-pricing helpers (`estimateCostUsd`, `estimateCostFromBreakdown`)
have been removed — cost is now sourced directly from
`response.usage.cost` returned by OpenRouter.

The package has no module-scoped HTTP client. Each `askLLM` call
constructs its own `fetch` request.

## On-disk decision cache

`askLLM` consults a filesystem-backed cache before issuing a request.
Implemented in `src/cache.ts`:

- **Location**: `~/.plumbline/repos/llmdecisions/<sha256-hex>.json` (one
  file per cache key). Resolved via `@bb/config`'s `getPlumblineHome()`.
- **Key**: `sha256(JSON.stringify({ provider, prompt, systemPrompt, modelChain }))`
  where `provider` is `"openrouter"` or `"ollama"` and `modelChain` is
  the resolved chain (capped-at-3 for OpenRouter, single-element for
  Ollama). `timeoutMs` is intentionally excluded. `provider` is part
  of the key so the same prompt + model string can be cached
  separately when run through different backends.
- **Entry shape**:
  `{ key, content, usage, modelChain, hitCount, createdAt, lastHitAt }`.
  Prompts are not stored — the hash is sufficient for lookup.
- **Hit flow**: log `[LLM CACHE HIT]`, fire-and-forget `recordHit`
  (bumps `hitCount` + `lastHitAt`), return cached `content` + `usage`.
  Returned `usage` reflects original token counts so caller-side
  accounting stays honest about what _would_ have been spent.
- **Miss flow**: log `[LLM CACHE MISS]`, call OpenRouter, write entry on
  success (fire-and-forget). On a parallel-miss race, last-write-wins;
  both writers produce semantically equivalent entries.
- **Failure mode**: cache reads/writes are best-effort. Any I/O error is
  logged with `[LLM CACHE WRITE FAILED]` and the LLM call proceeds
  unaffected.
- **Kill switch**: `Config.LlmCacheEnabled` (boolean, default `true`).
  Toggle via `plumbline set llm_cache_enabled <true|false>`. When
  `false`, both reads and writes are skipped.
- **TTL / eviction**: none in v0. Manual prune is `rm` on the entry
  file. A future `plumbline cache prune` lands alongside cost-ledger
  work.

## Data ownership

`@bb/llm` owns the decision-cache directory at
`~/.plumbline/repos/llmdecisions/`. No other package may read or write
it. The cost ledger described in [docs/arch.md](../../docs/arch.md) is
**not** owned by v0 — it lands when `plumbline cost` ships.

## Invariants

1. **OpenRouter or local Ollama, nothing else.** No direct
   Anthropic / OpenAI / Gemini / Bedrock SDKs. OpenRouter URL is fixed
   at `https://openrouter.ai/api/v1/chat/completions`; Ollama URL is
   user-configured via `Config.OllamaUrl` (default
   `http://localhost:11434`). Provider is selected by
   `Config.LlmProvider`, or by `opts.provider` when the caller wants to
   override on a per-call basis.
2. **Per-call credential override.** When `opts.apiKey` is set, the
   OpenRouter call uses it directly and skips `Config.OpenrouterApiKey`.
   This is the extension point that lets downstream consumers
   pre-resolve per-org credentials at the enqueue boundary and pass them
   through job payloads, without the LLM client knowing anything about
   per-org resolution. The Ollama provider is keyless and ignores
   `opts.apiKey`.
3. **No env reads.** API key + model come from `getConfigValue(...)` or
   `opts.apiKey`. No `process.env`, no `.env`. Repo-wide ESLint rule
   blocks `process.env`.
4. **OpenRouter-native fallback chain.** The request body sends
   `models: [primary, ...fallbacks]` whenever the deduplicated chain has
   ≥2 entries. Primary is `Config.OpenrouterModel`; fallbacks come from
   four discrete slots `Config.OpenrouterFallbackModel1` through
   `…Model4` (each a `string`; empty string means "skip this slot"). All
   four slots ship with curated defaults so a fresh install gets fallback
   without any user action. OpenRouter tries the chain in order and bills
   only the responder; `usage.model` reflects which one. Caller still
   sees a single `AskLlmResult`. the queue's `attempts: 3` wraps the whole
   call — retries walk the chain again, useful when a transient
   OpenRouter outage clears between retries.
   4a. **No upstream-provider fallback.** Every request carries
   `provider: { allow_fallbacks: false }`. This is orthogonal to the
   `models` chain in invariant 4 — `models` controls _which model_ the
   gateway tries; `allow_fallbacks` controls whether OpenRouter routes
   to a different upstream backend serving the same model when the first
   one stalls. We disable the latter so a slow provider cannot eat the
   wall-clock without ever producing tokens; the surfaced error becomes
   actionable (specific provider, specific status) instead of a generic
   timeout.
5. **Errors are typed, not strings.** `LlmConfigError` carries the exact
   `plumbline keys set` hint; `LlmError` carries `cause`.
6. **Timeout is enforced.** AbortController fires at `timeoutMs`; the
   resulting `AbortError` is wrapped in `LlmError` with the timeout in
   the message.
7. **Tokenizer is module-cached.** `tiktoken`'s `cl100k_base` encoder
   is lazy-initialized on first `tokenLen` call and reused for the
   process lifetime. Chosen because every modern OpenRouter chat model
   tokenizes within ~10% of `cl100k_base` for code-shaped input. Char/4
   fallback only fires on tokenizer init failure.

## External dependencies

- Bun's built-in `fetch` (no SDK, no axios)
- `tiktoken` — WASM-backed BPE tokenizer (matches kube-package's
  current `askLLM.ts`). Bun handles WASM modules natively.
- `@bb/config`, `@bb/types`, `@bb/errors` — all `workspace:*`

## What is intentionally out of scope (v0)

- Cost ledger (`~/.plumbline/cost-ledger.sqlite`) — lands with `plumbline cost`
- Streaming responses
- Tool / function calling
- A `askJsonLLM<T>(prompt, schema)` JSON-mode wrapper — caller does
  `JSON.parse` with a try/catch fallback today
- Per-call prompt logging
- Cache TTL / automatic eviction — manual `rm` for now
- Per-usage-record provider persistence — Ollama `$0` cost is keyed
  off the _current_ `Config.LlmProvider`. Historical OpenRouter rows
  still price correctly because their model IDs resolve in
  OpenRouter's pricing map regardless of the current provider.

## How to extend

Adding `askJsonLLM<T>(prompt, opts?): Promise<T>` when a second caller
needs strict JSON:

1. Implement in `src/json.ts` — calls `askLLM`, strips fences, parses
   with try/catch, throws `LlmError` on parse failure (caller currently
   does this inline).
2. Re-export from `src/index.ts`.
3. Update _Public exports_ here.

Adding a cost ledger when `plumbline cost` lands:

1. New file `src/ledger.ts` writing to
   `~/.plumbline/cost-ledger.sqlite` via `bun:sqlite`.
2. Wrap `askLLM` to capture `model`, prompt-token count, completion-token
   count, latency. Lookup pricing via a curated table.
3. Update _Out of scope_ → _Public exports_ here.
