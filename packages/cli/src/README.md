# `@bb/cli/src` — context

Implementation of `@bb/cli`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

## Files

- **[index.ts](index.ts)** — binary entry. Shebang `#!/usr/bin/env bun`.
  Constructs the commander `Command("plumbline")`, wires version, and
  registers every shipped subcommand: `set`, `boot`, `shutdown`,
  `server`, `index`, `ingest`, `ls`. Calls `parseAsync`. Top-level
  `try/catch` prints any uncaught error and exits `2` (the typed-error
  path through commander handlers exits `1`).
- **[SetCommand.ts](SetCommand.ts)** — the `set` subcommand. Two
  optional positional args. Both provided → headless flow: looks up
  `KEY_MAP[key]`, runs `entry.setter(value)`, prints success (or the
  redacted form for password-bearing keys). Neither provided → renders
  `<SetupForm />` via `ink.render`. Mismatched args → friendly error.
- **[keyMap.ts](keyMap.ts)** — the dispatch table from CLI key strings
  to typed `setConfigValue<K>` calls. Each entry is a closure that owns
  its own type narrowing — no `as` casts at the call site. Local
  helpers `parsePort` / `parsePositiveInt` / `parseLogLevel` throw
  `Error("Invalid value for \"<key>\": …")` which `SetCommand` pretty-
  prints with the matching `plumbline set …` hint from `@bb/config`'s
  `HINTS`. Carries entries for every config key the user can set
  headlessly today, including `openrouter-api-key` (`redact: true`)
  and `openrouter-model` (plain text).
- **[BootCommand.ts](BootCommand.ts)** — the `boot` subcommand.
  Sequence: `ensurePreflight` (if openrouter api-key/model are blank,
  renders `<SetupForm />` when stdin+stdout are a TTY so the user can
  fill them in-place; falls back to the legacy print-`HINTS`-and-exit
  path on non-TTY for CI) → `applyInfraDefaults` (auto-fills the
  blank infra keys, generates a random Neo4j password if needed) →
  `dockerInfra.up` (writes `.env`, runs compose, polls health) →
  `ensureServerRunning` (existing helper that lazy-spawns the server
  and polls `/health`). Prints a final ready banner with the MCP URL.
  Idempotent — re-running on an already-up stack is a fast no-op.
- **[ShutdownCommand.ts](ShutdownCommand.ts)** — the `shutdown`
  subcommand. Reads `~/.plumbline/pid`, sends `SIGTERM`, polls until
  the PID file vanishes (≤ 30 s), and prints the explicit
  `docker compose down` hint. Docker is left running by design.
  Stale PID file is treated as "already stopped" and exits 0.
- **[bootConfig.ts](bootConfig.ts)** — `applyInfraDefaults` writes
  local-docker defaults (neo4j / neo4j-user) and a
  random base64url 24-byte Neo4j password into `~/.plumbline/config.json`
  via `KEY_MAP[key].setter`, but only for keys that are currently
  blank. Returns the resolved Neo4j password (whether freshly
  generated or pre-existing) so `BootCommand` can pass it into
  `dockerInfra.up`. `checkPreflight` reads `openrouter_api_key` and
  `openrouter_model` and returns the missing entries with their
  `Config` enum value (so `BootCommand` can look up the right hint).
- **[dockerInfra.ts](dockerInfra.ts)** — wraps `docker compose -f
<abs>/infra/docker/docker-compose.yml up -d` (stdout/stderr
  inherited so the user sees pulls + start), then polls
  `docker compose ps --format json` every 2 s for ≤ 90 s until all
  three services report `Health: healthy`. Resolves the compose path
  via `import.meta.url` so it works under `bun link`. Writes
  `infra/docker/.env` (mode `0600`) with `NEO4J_PASSWORD=<value>`
  before `up`. Typed errors: `DockerNotFoundError` (no `docker` on
  PATH), `DockerComposeError` (non-zero compose exit), and
  `DockerHealthTimeoutError` (services still not healthy after the
  poll budget). `parsePsOutput` accepts both the JSON-array and
  newline-delimited-JSON formats compose ships across versions.
- **[output.ts](output.ts)** — three small print helpers:
  `success(line)`, `error(line, hint?)`, `list(label, items)`. Manual
  ANSI escapes wrapped behind a `stream.isTTY` check. Plain text on
  non-TTY (CI, pipes).
- **[McpCommand.ts](McpCommand.ts)** — the `mcp` subcommand group.
  `mcp stats` renders `/api/v1/mcp/stats` (global + per-identity token
  usage). `mcp install` delegates to `runMcpInstall` (below).
- **[mcpInstall.ts](mcpInstall.ts)** — orchestrator for `mcp install`.
  Resolves the endpoint URL from `Config.ServerPort`, filters
  `MCP_TARGETS` by `detect()`, prompts (interactive multi-select on a
  TTY; auto-selects all detected when stdin is not a TTY), then
  **merges** a `plumbline` entry into each picked tool's config and
  prints a result table. Merge is non-destructive: reads existing JSON
  (`{}` on ENOENT), backs up to `<file>.plumbline.bak`, injects only the
  `plumbline` key under the tool's top-level key, atomic-writes
  (tmp + rename, mode `0600`). A malformed existing file fails that one
  tool instead of being overwritten. Idempotent — keyed by the literal
  name `plumbline`, so re-running updates (e.g. a changed port) rather
  than duplicating.
- **[mcpTargets.ts](mcpTargets.ts)** — the `MCP_TARGETS` adapter table.
  One `McpTarget` per supported tool: `configPath()` (platform-branched
  — `~/Library/Application Support/…` on macOS, `~/.config/…` on Linux),
  `detect()` (config file / app dir present), `topLevelKey`
  (`mcpServers`, or `servers` for VS Code), and `entry(url)` (the
  per-tool entry shape — `{type,url}`, `{url}`, or `{serverUrl}`).
- **[McpToolSelector.tsx](McpToolSelector.tsx)** — Ink multi-select for
  `mcp install`. Mirrors `RepoSelector` multi-mode but defaults every
  detected tool to selected (the common case is "configure all"); `a`
  toggles all/none, Space toggles a row, Enter confirms, Esc cancels.
- **[Field.tsx](Field.tsx)** — single Ink row component used inside
  `SetupForm`. Renders an indicator + label + either an `ink-text-input`
  (when focused) or a static text view of the value (when not). Masking
  via `ink-text-input`'s `mask` prop on the password row; non-focused
  view shows `•••…` for masked rows. Renders an inline red error line
  underneath when the field's `validate` returns a non-null string.
- **[SetupForm.tsx](SetupForm.tsx)** — the Ink form rendered by
  `plumbline set` no-args **and** by `plumbline boot` when openrouter
  keys are missing on an interactive TTY. Nine rows declared in a
  `ROWS` constant: Neo4j URI / Neo4j user / Neo4j password
  (masked) / Server port / GitHub Concurrency / OpenRouter
  API key (masked) / OpenRouter model. Each row carries its own
  format-only `validate` regex (or non-empty check for the openrouter
  rows). State: a single `useState<Record<string,string>>` keyed by
  row id and seeded from `loadInitial()` so users see and edit
  existing settings. Navigation via Ink's built-in `useFocusManager`
  (Tab / Shift-Tab). On Enter when all rows pass validation, iterates
  the dispatch table in row order calling `entry.setter(value)`. On
  Esc, exits without saving.

## Module dependency graph

```
output.ts          → (leaf — no imports)
keyMap.ts          → @bb/types (Config), @bb/config (LOG_LEVELS, setConfigValue, LogLevel)
Field.tsx          → ink, ink-text-input, react (type-only)
SetupForm.tsx      → ink, react, @bb/types (Config), @bb/config (getConfigValue),
                     keyMap.ts (KEY_MAP), Field.tsx (Field)
SetCommand.ts      → commander, react, ink (render), @bb/config (HINTS),
                     keyMap.ts (KEY_MAP, validKeysList), SetupForm.tsx (SetupForm),
                     output.ts (error, list, success)

bootConfig.ts      → node:crypto, @bb/types (Config), @bb/config (getConfigValue),
                     keyMap.ts (KEY_MAP)
dockerInfra.ts     → node:child_process, node:fs/promises, node:path, node:url
BootCommand.ts     → commander, react, ink (render), @bb/types (Config),
                     @bb/config (HINTS, getConfigValue), bootConfig.ts, dockerInfra.ts,
                     serverSpawn.ts, SetupForm.tsx (SetupForm), output.ts
ShutdownCommand.ts → commander, node:fs/promises, node:path, @bb/config (getPlumblineHome),
                     dockerInfra.ts (composeFilePath), output.ts

httpClient.ts      → node:url
serverSpawn.ts     → node:child_process, node:fs/promises, node:path, node:url,
                     @bb/types (Config), @bb/config (getPlumblineHome, getConfigValue)

mcpTargets.ts      → node:path, node:fs (existsSync), node:os (homedir)
McpToolSelector.tsx → ink, react (type-only)
mcpInstall.ts      → node:path, node:fs, react, ink (render), @bb/types (Config),
                     @bb/config (getConfigValue), output.ts, mcpTargets.ts, McpToolSelector.tsx
McpCommand.ts      → commander, httpClient.ts, output.ts, mcpInstall.ts

ServerCommand.ts   → commander, node:child_process, node:path, node:url, output.ts
IndexCommand.ts    → commander, serverSpawn.ts, httpClient.ts, output.ts
IngestCommand.ts   → commander, node:fs/promises, node:path, serverSpawn.ts,
                     httpClient.ts, output.ts
LsCommand.ts       → commander, serverSpawn.ts, httpClient.ts, output.ts

index.ts           → commander, SetCommand, BootCommand, ShutdownCommand, ServerCommand,
                     IndexCommand, IngestCommand, LsCommand, output.ts
```

No cycles. `output.ts` is a leaf; `keyMap.ts` and `httpClient.ts` are
near-leaves. `serverSpawn.ts` and `dockerInfra.ts` both manage foreign
child processes and own no in-process state beyond a small per-call
context.

## Invariants enforced here

- **Shebang lives only in `index.ts`.** It is the binary entry; other
  files are imported.
- **Headless setter calls go through `KEY_MAP[key].setter`.** No file
  outside `keyMap.ts` calls `setConfigValue` directly. This keeps the
  type-narrowing closures the single source of truth and keeps password
  redaction (`entry.redact`) co-located with the setter.
- **Form runs format-only validation.** No network, no driver imports.
  Validators in `SetupForm.tsx`'s `ROWS` are pure regex / range checks.
- **Submit is atomic per call but not per form.** The form iterates
  six setters; each is its own atomic `setConfigValue` write. If one
  throws mid-loop, the form re-renders with the row's error highlighted
  and earlier fields stay written. Trade-off: rolling back partial
  writes would require a transaction abstraction in `@bb/config` that
  doesn't exist; the form's per-field format validation makes mid-loop
  failures essentially impossible in practice.
- **No raw `setConfigValue` casts.** Each `KEY_MAP` closure invokes
  `setConfigValue<Config.X>(Config.X, value)` so TypeScript checks the
  value type against `ConfigValueMap[Config.X]`. Adding a key without
  a closure (or with a wrong-type setter) is a compile error.
- **No env reads anywhere.** Repo-wide ESLint rule blocks `process.env`.
- **`bootConfig.applyInfraDefaults` only writes blank keys.** Re-running
  `plumbline boot` after a manual `plumbline set neo4j-password <new>`
  reads the user's value back via `getConfigValue` and uses it for
  the compose `.env`; it does **not** overwrite the user's choice.
- **`dockerInfra` resolves the compose file via `import.meta.url`.**
  No env vars, no cwd dependence — `plumbline boot` works from any
  directory and from `bun link`'d installs.
- **`ShutdownCommand` never escalates to `SIGKILL`.** If the server
  doesn't drain in 30 s the command exits 1 with a warning; the
  operator decides whether to force-kill. Matches the server's own
  shutdown timeout.

## Adding a Field

1. Add a row to `ROWS` in `SetupForm.tsx` — `{ id, label, cliKey, mask?, validate }`.
2. Confirm `KEY_MAP[cliKey]` exists in `keyMap.ts` (add it there if not).
3. Add the new key to the `loadInitial()` seed object so the field
   pre-populates from the existing config.
4. The form auto-renders the row in declaration order; no other
   wiring needed.
