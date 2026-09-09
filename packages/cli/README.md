# `@bb/cli` — context

## Tier

Binary (deployable). Top of the import graph alongside `@bb/server`.
Depends on Kernel (`@bb/types`, `@bb/errors`) and Infrastructure
(`@bb/config`). Imported by no other workspace package — published as the
user-facing `plumbline` binary.

May **not** import `@bb/server`, `@bb/queue`,
`@bb/llm`, `@bb/ingest-github`, or `@bb/logger`. The CLI talks HTTP to a
running `plumbline-server` (when subcommands need server state), spawns
the server and `docker compose` as foreign child processes, and
otherwise operates only on `~/.plumbline/` via `@bb/config`.

## Responsibility

The user-facing terminal UI for Plumbline. Arch-spec'd at
[docs/arch.md _TUI Spec_ §144-184](../../docs/arch.md#L144-L184) — single
mode, every invocation is interactive in spirit, with subcommands for
indexing, configuration, server lifecycle, and inspection.

**v0 surface:** `setup`, `set`, `boot`, `shutdown`, `server start`, `index`,
`ingest`, `ls`, `delete`, `stats`.

- `plumbline setup` — interactive first-run wizard. Presents an Ink multi-stage
  form: (1) pick LLM provider (`openrouter` | `ollama`), (2) pick infrastructure
  mode — **Docker** (non-embedded: neo4j, the default selection,
  labelled "Docker needed") or **Embedded** (sqlite + ladybug + honker, no Docker,
  labelled "recommended"),
  (3) enter credentials / model, (4) optionally supply a GitHub repo URL to index
  after boot, (5) confirm. The infra mode is a single selector that expands to the
  three `db/graph/queue` provider keys via `applyInfraMode()` (see `infraMode.ts`).
  On confirm: applies config via `KEY_MAP` setters (same path as `plumbline set`),
  stops any running server, starts a fresh server, prints the MCP endpoint, and
  if a repo URL was given kicks `POST /api/v1/github/index` then polls to
  completion via the shared `pollIndexToCompletion()` helper. Requires an
  interactive TTY; exits with an error otherwise.
- `plumbline set <key> <value>` — headless write to
  `~/.plumbline/config.json` via `@bb/config.setConfigValue`. Type
  coercion + Zod validation + atomic `tmp → fsync → rename`. Sole
  sanctioned write path per [docs/arch.md:140](../../docs/arch.md#L140).
- `plumbline set` (no args) — Ink setup form. Presents a single
  **Infrastructure** toggle (`docker|embedded`, default `docker`, embedded
  labelled "recommended"). In
  Docker mode it walks Neo4j / Neo4j-user / Neo4j-password /
  text fields (with field-level format validation) plus Port /
  GitHub-concurrency / OpenRouter fields; in Embedded mode the
  neo4j rows are hidden and not required. On submit, the
  mode expands to the three provider keys via `applyInfraMode()` and
  every visible value is applied atomically through the same
  `setConfigValue` path. Esc cancels.
- `plumbline boot` — one-command bring-up. Refuses to proceed if
  `openrouter_api_key` or `openrouter_model` is blank (with the
  matching `plumbline set …` hint). Whether Docker is started is derived
  from the active provider combo (`needsDocker()` / `isEmbedded()` in
  `infraMode.ts`): **embedded** (sqlite + ladybug + honker) skips Docker
  entirely and goes straight to starting the server; **non-embedded**
  brings Docker up. Either way it auto-fills blank infra
  config keys (only for the providers in use): embedded fills the
  `~/.plumbline` store paths (`sqlite-path` / `ladybug-path` /
  `queue-db-path` — Ladybug in particular needs a real path or it runs
  in-memory), Docker fills the neo4j URIs and generates a
  random Neo4j password if one isn't already set. In Docker mode it writes
  `infra/docker/.env` (Neo4j password + host ports derived from the
  configured URIs), runs `docker compose -f
infra/docker/docker-compose.yml up -d` for **only the services the
  providers require** (neo4j), polls
  `docker compose ps --format json` until they report
  `healthy`, then invokes `ensureServerRunning()` (existing helper) to
  spawn `plumbline-server`. Idempotent — re-running on an already-up
  stack is a fast no-op. When a compose host port is already taken,
  boot drops into an Ink picker (`PortConflictSelector.tsx`) offering
  three choices: reuse the existing service on that port (compose
  starts only the unconflicted services), stop the conflicting
  container and reuse the port, or change plumbline's host port for
  the affected service (the neo4j-bolt URI gets rewritten
  via `setConfigValue`, compose env is regenerated, retry). Up to
  four conflict rounds before giving up.
- `plumbline shutdown` — sends SIGTERM to the server PID, polls until
  the PID file vanishes (≤ 30 s), then asks (Ink prompt
  `StopInfraPrompt.tsx`) whether to stop Docker infra too. Default
  answer is **Yes** (Enter tears down `neo4j` via
  `docker compose down --remove-orphans`); pressing `n` / Esc keeps the
  containers running for fast warm re-boots and prints the manual
  `docker compose down` hint. The prompt is skipped when stdin isn't a
  TTY (CI-safe — falls back to keeping infra up). Two flags override
  the prompt deterministically: `--with-docker` always stops infra,
  `--keep-docker` always leaves it running; passing both is rejected.
- `plumbline server start` — low-level wrapper that spawns the server
  in the foreground (Ctrl+C to stop). Used during dev; everyday users
  prefer `plumbline boot`.
- `plumbline index <git-url>` / `plumbline ingest [path]` / `plumbline ls`
  — talk HTTP to a running server (lazy-spawn via
  `serverSpawn.ensureServerRunning` when the daemon is down). `ls` supports
  an interactive mode (`-i`) for hierarchical browsing of repos and commits.
- `plumbline delete` — list indexed knowledge in an Ink arrow-key picker
  (`DeleteSelector.tsx`, plain `useInput` — no extra dep), and on
  confirm `DELETE /api/v1/repos/:id` against the running server. The
  server cancels any pending queue jobs, then `DETACH DELETE`s the
  Neo4j subgraph and removes the SQLite `knowledge` / `raw` /
  `processing_stats` rows for that id.
- `plumbline stats` — `GET /api/v1/stats` and render TOTALS / REPOS /
  COMMITS tables. Cost is per-model OpenRouter pricing computed
  server-side; rows with unknown pricing render as `unknown`.
- `plumbline --help` / `--version` — commander defaults.

The package does **not** own:

- Any other subcommand (index, ls, clean, models, keys, cost, server,
  mcp, update) — all deferred per the catalog below.
- Live infra connection probes — the CLI cannot import the infra
  packages per the tier rule. Format-only validation in v0; future
  `plumbline config doctor` will probe via a running server.
- The Ink dashboard (`plumbline` no-args) — needs the server's HTTP API
  - activity feed.
- OpenRouter API key handling — own subcommand (`plumbline keys set`)
  with `keytar` keychain backing.

## Public exports

`@bb/cli` is a binary, not a library. Its only contract is the `bin`
entry in `package.json`:

```jsonc
{ "bin": { "plumbline": "./src/index.ts" } }
```

Publish-time builds swap to `./dist/index.js`. v0 dev workflow runs the
TS file directly via Bun's `#!/usr/bin/env bun` shebang; install with
`cd packages/cli && bun link` to put `plumbline` on `PATH`.

The TypeScript module exports (`buildSetCommand`, `KEY_MAP`, etc.) are
**internal** — no other workspace package imports `@bb/cli`.

## Data ownership

None directly. The CLI is a thin shell over `@bb/config`'s atomic
writer — it owns no module state, no caches, no on-disk artifacts of its
own. `~/.plumbline/config.json` is `@bb/config`'s data; CLI just writes
through it.

## Invariants

1. **No env reads.** No `process.env`. The setter primitive enforces
   this; the CLI is a transparent caller.
2. **Atomic writes.** Every successful `set` invocation triggers
   `setConfigValue` which writes via `tmp → fsync → rename` at mode
   `0600` in dir `0700`.
3. **Tier discipline.** No imports from `@bb/server`, `@bb/queue`,
   `@bb/llm`, `@bb/ingest-github`. Blocked
   structurally (no workspace dep) and by ESLint boundary rule.
   Foreign processes the CLI is allowed to manage by signal:
   `bun … packages/server/src/index.ts` (the server daemon) and
   `docker compose -f infra/docker/docker-compose.yml …` (the local
   infra). Both are spawned via `child_process.spawn` — neither is
   an in-process import.
4. **Redaction in stdout.** Password-bearing keys
   (today: `neo4j-password`, `openrouter-api-key`) print `<redacted>`
   on success — the raw value never appears in stdout / stderr / logs.
5. **`openrouter-api-key` and `openrouter-model` are headless-set
   keys** in `KEY_MAP`. The api key is `redact: true`; the model is
   plain text. The pre-flight inside `plumbline boot` blocks bring-up
   until both are non-empty.
6. **Format-only validation in v0.** The setup form's per-field
   validators check shape (`bolt://`, integer port, etc.)
   but never make network calls.
7. **TUI naming convention.** `*Command.ts` for commander handlers
   (plain TS), `*Form.tsx` / `*Pane.tsx` for Ink components (JSX).
   Per [CLAUDE.md _Naming Conventions_](../../CLAUDE.md).

## External dependencies

- `commander` — argv parsing + subcommand wiring
- `ink` + `react` — Ink TUI runtime (React for terminals)
- `ink-text-input` — controlled text input field
- Workspace deps: `@bb/config`, `@bb/errors`, `@bb/types`

No `chalk` / `kleur` / `picocolors` — manual ANSI escapes wrapped
behind a `tty?` check (see `output.ts`).

## Full TUI catalog (planned interface)

The complete arch-spec'd command surface, grouped by what each command
will touch when implemented. Only the **bolded** entries ship in v0.

| Invocation                                        | Behavior                                                                                                                                                                                               | When it lands                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **`plumbline setup`**                             | **First-run wizard: pick LLM provider, configure keys/model, boot server, optionally kick index. v0.**                                                                                                 | **Shipped**                                 |
| **`plumbline set <key> <value>`**                 | **Headless write via `setConfigValue`. v0.**                                                                                                                                                           | **Shipped**                                 |
| **`plumbline set`**                               | **Ink setup form (6 infra fields). v0.**                                                                                                                                                               | **Shipped**                                 |
| **`plumbline boot`**                              | **Pre-flight + auto-fill infra keys + `docker compose up -d` + spawn server.**                                                                                                                         | **Shipped**                                 |
| **`plumbline shutdown`**                          | **SIGTERM the server, leave Docker running.**                                                                                                                                                          | **Shipped**                                 |
| **`plumbline server start`**                      | **Spawn `plumbline-server` in foreground.**                                                                                                                                                            | **Shipped**                                 |
| **`plumbline index <git-url>`**                   | **POST `/api/v1/github/index` to local server.**                                                                                                                                                       | **Shipped**                                 |
| **`plumbline ingest [path]`**                     | **POST `/api/v1/local/index` for a directory tree.**                                                                                                                                                   | **Shipped**                                 |
| **`plumbline ls`**                                | **Render `/api/v1/repos` as a table or interactive explorer (`-i`). v0.**                                                                                                                              | **Shipped**                                 |
| **`plumbline delete`**                            | **Ink picker over `/api/v1/repos`, then DELETE `/api/v1/repos/:id` (SQLite + Neo4j + jobs).**                                                                                                          | **Shipped**                                 |
| **`plumbline stats`**                             | **Render `/api/v1/stats` (totals + per-repo + per-commit token / cost rows).**                                                                                                                         | **Shipped**                                 |
| `plumbline`                                       | Ink dashboard with Repos / Server / Activity / Cost panes ([docs/arch.md:172-184](../../docs/arch.md#L172-L184))                                                                                       | After `@bb/server` HTTP API + activity feed |
| `plumbline` (first-run auto-launch of setup form) | If `isConfigComplete()` returns false, redirect to `plumbline set` form ([docs/arch.md:170](../../docs/arch.md#L170))                                                                                  | After dashboard lands                       |
| `plumbline models set <model-id>`                 | Validate model via OpenRouter API + write `openrouter_model`                                                                                                                                           | After OpenRouter helper                     |
| `plumbline models ls`                             | Curated 5-10 models, on-the-fly OpenRouter pricing                                                                                                                                                     | Same                                        |
| `plumbline keys set`                              | Interactive masked prompt → `keytar` keychain → write key                                                                                                                                              | After `keytar` integration                  |
| `plumbline cost`                                  | Read `~/.plumbline/cost-ledger.sqlite` via `bun:sqlite`, render breakdowns                                                                                                                             | After cost ledger lands in `@bb/llm`        |
| `plumbline server stop \| status \| logs`         | Kill / inspect `plumbline-server`, tail server logs (start is shipped — see above)                                                                                                                     | After `@bb/server` health surface           |
| `plumbline mcp`                                   | Print MCP endpoint URL + sample MCP-client config                                                                                                                                                      | After dashboard pane                        |
| `plumbline infra up \| down \| status \| logs`    | Thin wrapper over `docker compose` for users who want explicit infra control                                                                                                                           | If usage demands it post-v0                 |
| `plumbline update`                                | Detect install method, run matching update, restart server                                                                                                                                             | Release-engineering follow-up               |
| Invocation                                        | Behavior                                                                                                                                                                                               | When it lands                               |
| ------------------------------------------------  | -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------  | ------------------------------------------- |
| **`plumbline set <key> <value>`**                 | **Headless write via `setConfigValue`. v0.**                                                                                                                                                           | **Shipped**                                 |
| **`plumbline set`**                               | **Ink setup form (6 infra fields). v0.**                                                                                                                                                               | **Shipped**                                 |
| **`plumbline boot`**                              | **Pre-flight + auto-fill infra keys + `docker compose up -d` + spawn server.**                                                                                                                         | **Shipped**                                 |
| **`plumbline shutdown`**                          | **SIGTERM the server, leave Docker running.**                                                                                                                                                          | **Shipped**                                 |
| **`plumbline server start`**                      | **Spawn `plumbline-server` in foreground.**                                                                                                                                                            | **Shipped**                                 |
| **`plumbline index <git-url>`**                   | **POST `/api/v1/github/index` to local server.**                                                                                                                                                       | **Shipped**                                 |
| **`plumbline ingest [path]`**                     | **POST `/api/v1/local/index` for a directory tree.**                                                                                                                                                   | **Shipped**                                 |
| **`plumbline ls`**                                | **Render `/api/v1/repos` as a table or interactive explorer (`-i`). v0.**                                                                                                                              | **Shipped**                                 |
| **`plumbline delete`**                            | **Ink picker over `/api/v1/repos`, then DELETE `/api/v1/repos/:id` (SQLite + Neo4j + jobs).**                                                                                                          | **Shipped**                                 |
| **`plumbline stats`**                             | **Render `/api/v1/stats` (totals + per-repo + per-commit token / cost rows).**                                                                                                                         | **Shipped**                                 |
| `plumbline`                                       | Ink dashboard with Repos / Server / Activity / Cost panes ([docs/arch.md:172-184](../../docs/arch.md#L172-L184))                                                                                       | After `@bb/server` HTTP API + activity feed |
| `plumbline` (first-run auto-launch of setup form) | If `isConfigComplete()` returns false, redirect to `plumbline set` form ([docs/arch.md:170](../../docs/arch.md#L170))                                                                                  | After dashboard lands                       |
| `plumbline models set <model-id>`                 | Validate model via OpenRouter API + write `openrouter_model`                                                                                                                                           | After OpenRouter helper                     |
| `plumbline models ls`                             | Curated 5-10 models, on-the-fly OpenRouter pricing                                                                                                                                                     | Same                                        |
| `plumbline keys set`                              | Interactive masked prompt → `keytar` keychain → write key                                                                                                                                              | After `keytar` integration                  |
| `plumbline cost`                                  | Read `~/.plumbline/cost-ledger.sqlite` via `bun:sqlite`, render breakdowns                                                                                                                             | After cost ledger lands in `@bb/llm`        |
| `plumbline server stop \| status \| logs`         | Kill / inspect `plumbline-server`, tail server logs (start is shipped — see above)                                                                                                                     | After `@bb/server` health surface           |
| **`plumbline mcp install`**                       | **Detect installed coding tools (Claude Code, Cursor, Claude Desktop, Windsurf, VS Code) and merge a `plumbline` MCP server entry into each one's config, pointing at `http://127.0.0.1:<port>/mcp`.** | **Shipped**                                 |
| **`plumbline mcp stats`**                         | **Render `/api/v1/mcp/stats` (global + per-identity MCP token usage).**                                                                                                                                | **Shipped**                                 |
| `plumbline infra up \| down \| status \| logs`    | Thin wrapper over `docker compose` for users who want explicit infra control                                                                                                                           | If usage demands it post-v0                 |
| `plumbline update`                                | Detect install method, run matching update, restart server                                                                                                                                             | Release-engineering follow-up               |

## Migrations

- `plumbline migrate paths [--dry-run]` — one-shot move of the legacy
  on-disk layout (`~/.plumbline/repos/<id>/` for clones,
  `~/.plumbline/repos/.meta/<id>/...` for meta) into the commit-scoped tree
  (`~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/...`).
  The disk work lives in `@bb/path-migration`; this command supplies the
  knowledge list from the document store and renders the summary. The **same reconciliation runs
  automatically at server boot** (see `@bb/server`), so this command is for
  running it ahead of time or with `--dry-run` to preview. `--dry-run` prints
  the plan (including would-be-deleted orphans) without touching disk. Reads
  `KnowledgeDoc` from the document store to derive each knowledge's
  `(orgId, owner, repo, commitId)`; knowledges that predate commit tracking
  (no `source.commitId`) or have no `info.repoUrl` are skipped with a per-id
  reason and need manual `plumbline delete` + re-index. Legacy dirs with **no**
  backing `KnowledgeDoc` are unrecoverable — they are deleted and reported as
  `abandoned`. Local-source knowledges keep their original `source.sourcePath`
  untouched; only their `meta-output` tree moves.

## What is intentionally out of scope (v0)

- Every TUI surface in the table above except `set` and the help/version
  defaults
- Live connection probes inside the setup form
- First-run auto-launch of setup form (needs the dashboard pane first)
- OpenRouter API key in the setup form (separate `plumbline keys set`)
- Tests — workspace has no test infra yet
- Color theming via `kleur` / `picocolors` — manual ANSI for now
- Distinct exit codes per failure mode (today: `1` = typed/handled error,
  `2` = uncaught crash)

## How to extend

Key source files added in the `setup` command:

- `src/SetupCommand.ts` — commander entry point for `plumbline setup`; orchestrates wizard → config apply → boot → optional index (private-repo PAT + branch selection via `probeRepo`) → MCP-client install.
- `src/InstallWizard.tsx` — Ink multi-stage wizard component (provider picker + stage routing).
- `src/InstallWizardStages.tsx` — `FieldsStage`, `RepoStage`, `ConfirmStage` sub-components (split from `InstallWizard.tsx` to honour the 300-line rule).
- `src/indexPoller.ts` — shared `pollIndexToCompletion()` used by both `IndexCommand.ts` and `SetupCommand.ts`; also exports the `IndexResponse` and `RepoStatus` types so neither command duplicates them.
- `src/repoProbe.ts` — shared `probeRepo()` used by both `IndexCommand.ts` and `SetupCommand.ts`: probes `/api/v1/github/probe`, prompts for a PAT on private repos, and (in a TTY) lets the user pick a branch. Returns `{ branch, token }` with `branch === null` meaning cancel/failure.

Boot and shutdown logic reused by `setup`:

- `src/bootConfig.ts` — owns `applyInfraDefaults()`, `checkPreflight()`, and `runBootSequence()` (the shared defaults → docker-up → server-start sequence). Both `BootCommand.ts` and `SetupCommand.ts` delegate to `runBootSequence()`.
- `src/dockerBoot.ts` — owns `bringInfraUp()`: Docker Compose bring-up with port-conflict handling.
- `src/serverLifecycle.ts` — owns `startServer()` and `stopServer()` (SIGTERM + pid-file poll). `ShutdownCommand.ts` and `SetupCommand.ts` both delegate here.
- `src/serverSpawn.ts` — owns `ensureServerRunning()`: low-level server process spawn, health polling, TCP infra preflight, and early-exit detection with log tail.

Adding a new subcommand:

1. Create `src/<Name>Command.ts` (PascalCase, plain `.ts`) exporting
   `build<Name>Command(): Command`.
2. If interactive panes / forms are needed: add `src/<Name>Form.tsx`
   (or `<Name>Pane.tsx`) per [CLAUDE.md _Naming Conventions_](../../CLAUDE.md).
3. Wire into `src/index.ts`: `program.addCommand(build<Name>Command())`.
4. If the command speaks to `plumbline-server`: HTTP only (e.g. `fetch`
   to `http://localhost:<server_port>`). Never import `@bb/server`.
5. If the command needs OS primitives (`keytar`, `bun:sqlite`,
   `child_process`): add the dep to `package.json`, but never import a
   domain / strategy / infra-non-config workspace package.
6. Update _Public exports_ / _Out of scope_ in this file and the table
   above — move the row from "deferred" to "shipped".

Adding a new headless `set` key:

1. Add a `Config` enum entry in `@bb/types/src/config.ts` (and the
   schema / hint in `@bb/config`).
2. Add a `KEY_MAP` entry in `src/keyMap.ts`. The closure form keeps
   `setConfigValue<K>(key, ConfigValue<K>)` strictly typed.
3. If the key is interactive-form-relevant: add a `Row` to the
   `ROWS` array in `src/SetupForm.tsx` with a `validate` function.
