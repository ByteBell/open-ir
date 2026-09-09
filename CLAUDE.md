# CLAUDE.md — Plumbline-public

---

## Project Summary

**Plumbline-public** is an open-source, single-tenant local knowledge engine. It ingests GitHub repo into a durable knowledge graph and serves them through an MCP retrieval surface — all from a single Bun-based process running on the user's machine.

It ships two binaries from a single workspace:

- **`plumbline-server`** — a single Express daemon hosting ingestion routes (`/api/v1/...`), the MCP transport (`/mcp`, HTTP + SSE), and SQLite-backed queue workers in-process.
- **`plumbline`** — an Ink/React TUI driven by commander subcommands (`boot`, `index`, `ingest`, `ls`, `delete`, `set`, `server`, `shutdown`, `stats`). Interactive only — no `-p` / headless mode.

The system is **BYO-infra** (the user runs Neo4j; the document store and job queue are local SQLite files). Everything is single-tenant with a hardcoded `orgId="local"`. There is no auth, no users, no orgs, and the local server makes no outbound calls except to the user-selected LLM backend (OpenRouter or a user-supplied Ollama URL).

The repository is licensed under **AGPL-3.0 with an additional non-commercial use clause** — see [LICENSE](LICENSE) at the repo root. Commercial use requires a separate license; there is no in-process license-gating.

Architecturally, it is a **package-first Bun workspace** under `packages/*` with `@bb/*` naming. See [docs/arch.md](docs/arch.md) for the full PRD.

---

## High-Level Flow

```
TUI / HTTP client → Express (plumbline-server) → Queue (in-process) → IngestionStrategy → Graph + Storage
                                              ↘ MCP tools → Neo4j / SQLite retrieval
```

- The CLI never touches SQLite or Neo4j directly — it only talks HTTP to `plumbline-server`.
- Ingestion is asynchronous via the queue. Workers run **inside** the server process; there is no separate worker fleet.
- A worker (e.g. `handleGithubIndex`) clones the repo, runs the active `IngestionStrategy` (today: `BasicFileAnalysisStrategy` — file-walk + per-file LLM analysis), upserts file rows to SQLite + file nodes to Neo4j, and transitions `KnowledgeState`.
- MCP requests dispatch to the same SQLite + Neo4j the ingestion side wrote.

---

## Tech Stack

- **Runtime**: Bun ≥ 1.1 (required)
- **Language**: TypeScript (strict, all flags on — see [tsconfig.base.json](tsconfig.base.json))
- **HTTP server**: Express 5
- **TUI**: Ink (React for terminals) + commander
- **Databases**: SQLite (embedded, `~/.plumbline/data.sqlite`), Neo4j (BYO — user-supplied URI)
- **Queue**: Honker (SQLite-backed, in-process workers)
- **Local persistence**: `~/.plumbline/` (config, logs)
- **LLM Provider**: OpenRouter (default) or local Ollama, selected via `Config.LlmProvider`
- **Logging**: Winston (file + stdout)
- **Secret storage**: plaintext in `~/.plumbline/config.json` (mode `0600`). OS-keychain integration is not implemented.
- **Package manager**: Bun (workspaces)

---

## Architecture Tiers

Packages live under `packages/*` and are arranged in tiers. **Imports flow downward only** — a higher tier may depend on a lower tier, never the reverse.

```
Binaries          server, cli
        ↑
Domain            mcp, ingest-github
        ↑
Strategy          queue
        ↑
Cross-cutting     llm
        ↑
Infrastructure    config, logger, db, sqlite, neo4j
        ↑
Kernel            types, errors
```

- `@bb/server` and `@bb/cli` are **the only deployables**. They never import each other — they communicate over HTTP only (enforced by an ESLint boundary rule).
- `@bb/cli` may import `@bb/types` and `@bb/config` (for shared shapes / paths) but must not pull in domain or strategy packages.
- A package may not import from a sibling at the same tier unless the dependency is explicitly modeled in `package.json`.

---

## Core Principles

### 1. Local-First, Single-Tenant

There is exactly one tenant: `orgId="local"`. A single shim in the document-store adapter injects this on every read/write; Neo4j queries always filter on it. Do not add per-tenant logic. Do not add auth middleware. Do not introduce user/org concepts.

### 2. One Package, One Responsibility

Each package owns exactly one concern. If a package needs a second name to describe what it does, split it.

### 3. Composition Roots Are Thin

`@bb/server` and `@bb/cli` wire packages together. They contain **no business logic**. All logic lives in domain or strategy packages.

### 4. Strict Separation of Layers

- **Routes** → HTTP shape only (parse + validate + delegate)
- **Services** → Business logic + queue submission
- **Workers** → Async job execution (in-process, SQLite-backed queue); each worker dispatches to an `IngestionStrategy`
- **Strategies** → How a cloned repo is turned into SQLite rows + Neo4j nodes
- **Adapters** (`@bb/sqlite`, `@bb/neo4j`) → External system I/O

No layer skips another. The TUI is a special case: it is a thin HTTP client over the same routes; it does not reach into adapters.

### 5. Strategy-Based Ingestion

Ingestion is dispatched through `IngestionStrategy` (`@bb/ingest-github/Strategy.ts`). The active strategy today is `BasicFileAnalysisStrategy` — file-walk + per-file LLM analysis, returning `IngestionResult` (files analysed + per-model token breakdown). New ingestion shapes (AST extraction, dependency-graph extraction, etc.) land as new strategies behind the same interface, never as ad-hoc forks of the worker.

### 6. Reliability Over Speed

- Every job is retryable
- Every state transition is persisted
- Dead-letter queues exist for every queue
- Long-running tasks checkpoint progress
- Partial failures are recoverable

### 7. Data Integrity

- Processing states are enums, never strings
- Inputs validated (Zod) before queue submission
- LLM outputs are untrusted until normalized
- Knowledge entities are immutable once `PROCESSED` — new versions, never mutations

### 8. Observability

- Structured logging via `@bb/logger` (file + stdout, written to `~/.plumbline/logs/`)
- Request and job IDs propagate across pipelines
- Health checks for every external system (SQLite / Neo4j probes)
- Token usage is persisted in SQLite (`mcp_activity`, `usage_summary`) for the `plumbline stats` command

There is **no outbound telemetry**. The server does not phone home; logs stay on the user's machine.

### 9. Identifiers

- Public IDs are UUID v4
- Row/document primary keys are internal only
- UUID fields are indexed and unique
- Job IDs are globally traceable
- `install_id` (UUID, generated locally on first run, stored at `~/.plumbline/install_id`) is a stable local identifier used by the CLI dashboard. It is never transmitted off the machine.

---

## Processing Status Lifecycle

```
CREATED → QUEUED → INGESTED → PROCESSING → PROCESSED
                                         ↘ FAILED
```

States are explicit, never inferred. Transitions are persisted before the next phase begins. Surfaced via `plumbline ls` and the dashboard's Repos pane.

---

## Local Config Layout

The `~/.plumbline/` directory is the **single source of truth** for runtime configuration. There is no `.env` file (see Rule of Env Vars).

```
~/.plumbline/
  config.json           server_port, sqlite_path, queue_db_path,
                        neo4j_uri/user/password, openrouter_api_key,
                        openrouter_model, concurrency.github, log_level,
                        log_retention_days
                        (mode 0600; openrouter_api_key stored in plaintext)
  data.sqlite           document store — knowledge docs, raw file rows,
                        activity, usage, enrichment ledger
  queue.db              Honker job queue (SQLite)
  install_id            UUID generated on first run (local-only, never transmitted)
  repos/<knowledgeId>/  cloned source trees for every indexed repo
  logs/
    server-YYYY-MM-DD.log
    cli-YYYY-MM-DD.log
  pid                   running server PID
```

There is no OS-keychain integration; `openrouter_api_key` lives in plaintext in `config.json` (mode `0600`).

- `plumbline set <key> <value>` is the only sanctioned write path to `config.json`. Manual edits work but are not advertised.

---

# RULES (Hard Constraints)

These are enforced. Violations block PRs.

---

## Rule of Exploration

**Before touching code, read the context.**

Every contributor — human or AI agent — must, before making any change:

1. Read this `CLAUDE.md` end-to-end at least once per session.
2. Read [docs/arch.md](docs/arch.md) when working on architecture, ingestion flow, or distribution.
3. Read the `README.md` of every package and folder you will modify, plus the `README.md` of every package you import from.
4. If a `README.md` is missing where one is required, stop and create it (or flag it) before making changes.
5. If the code contradicts `README.md`, treat `README.md` as authoritative for _intent_ — investigate the drift and update one or the other in the same PR. Never silently align one to the other.

Skipping exploration is the most common cause of tier violations, duplicated logic, and broken invariants.

---

## Rule of File Size

**No source file may exceed 300 lines.**

- Applies to all `*.ts` / `*.tsx` files in `packages/*`
- Tests, generated files, and JSON fixtures are exempt; documentation is held to the same limit
- When you need to add to a file already near the limit, split it first, then add

---

## Rule of Strict Types

TypeScript runs with every strict flag enabled (see [tsconfig.base.json](tsconfig.base.json)).

- Never use `any` — use `unknown` and narrow
- Never use `@ts-ignore`. `@ts-expect-error` is allowed only with a comment explaining the suppression and a tracking issue
- Never use the non-null assertion `!` to silence the compiler
- All public package exports must have explicit return types

---

## Rule of Package Manager

**Bun only.** No `npm` or `yarn` lockfiles in this repo. All scripts must be Bun-compatible. Add dependencies with `bun add`, never by hand-editing `package.json`. The runtime requires Bun on the user machine even when the CLI is installed via npm.

---

## Rule of Workspace Imports

Cross-package imports use the workspace name only.

- ✅ `import { X } from "@bb/types"`
- ❌ `import { X } from "../../types/src"`

Within a package, intra-package imports may use a path alias (e.g. `src/...`) but **never relative parent traversal**:

- ✅ `import { X } from "src/services/foo"`
- ❌ `import { X } from "../../services/foo"`

A package never reaches into another package's internals — only its public `index.ts` (or declared subpath exports).

---

## Rule of Dependency Direction

Imports follow tier order (see Architecture Tiers above). A package's `package.json` `dependencies` block is the source of truth — if you add an import, you must add the dependency. Cycles are forbidden.

**`@bb/cli` and `@bb/server` may not import each other.** They communicate over HTTP only. This is enforced by an ESLint boundary rule (see verification step 16 in [docs/arch.md](docs/arch.md)).

---

## Rule of Module Imports (ESM)

The codebase is pure ESM.

- Never use `require()` — it is not defined at runtime
- Never use dynamic `import()` — all imports are static and top-level
- Conditional features gate **usage**, not the import

---

## Rule of Env Vars

**No `.env` file. Anywhere. Ever.**

- Every setting lives in `~/.plumbline/config.json` and is written exclusively by `plumbline set …` (or the first-run setup form)
- The server reads `config.json` directly via `@bb/config` and **must refuse to read `process.env.NEO4J_URI`** or any equivalent
- No `.env.example`, no `dotenv` package as a dependency, no `-env-file` flag

```ts
import { getConfigValue, Config } from "@bb/config";
const uri = getConfigValue(Config.Neo4jUri);
```

If a piece of infra is missing from `config.json`, the server prints the exact `plumbline set …` command and refuses to boot.

---

## Rule of LLM Provider

**OpenRouter or local Ollama. No direct vendor SDKs.** No Anthropic / OpenAI / Gemini / Bedrock keys or SDK imports. The active backend is selected by `Config.LlmProvider` (`"openrouter"` default | `"ollama"`) and switched via `plumbline set llm-provider <openrouter|ollama>`. Ollama mode reads `Config.OllamaUrl` (default `http://localhost:11434`) and `Config.OllamaModel` (free-form — any locally-pulled model) and reports `$0` cost. All LLM calls flow through `@bb/llm`, which:

- Wraps every OpenRouter / Ollama call behind a single `askLLM` surface
- Computes per-call cost via `estimateCostUsd()` against live OpenRouter pricing for the `plumbline stats` view (short-circuits to `0` when provider is Ollama)

LLM outputs are probabilistic. They must be:

- Validated against a schema before use
- Normalized before persistence
- Never written directly to a domain store

The user-facing model list is curated (5–10 top models). `plumbline models set` validates against OpenRouter on the fly.

---

## Rule of License File

The repository is licensed under **AGPL-3.0 with an additional non-commercial use clause**. The `LICENSE` file at the repo root is authoritative; README and CLAUDE.md only summarise it.

- Commercial use is governed by license terms.

- Do not introduce code paths that materially weaken AGPL copyleft (e.g. dynamic-linking shims that argue the running server is not a derivative work). If a feature requires that posture, raise it before implementing.
- New code files should carry an SPDX header: `// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause` (matches the LICENSE file).

---

## Rule of No Outbound Calls

The local server makes no outbound network calls except to the user-selected LLM backend: OpenRouter, or a user-supplied Ollama URL. There is no telemetry, no analytics, no license-issuance call, no auto-update probe.

- Do not add a `@bb/telemetry` package, a `telemetry-buffer.ndjson`, a `https://*.bytebell.ai` endpoint call, or any background HTTP shipper.
- If observability requirements change in the future, raise the proposal explicitly — do not add a phone-home flow as a side effect of another feature.

---

## Rule of API Logging & Documentation

Every HTTP route declares:

- OpenAPI / Swagger schema (request, response, errors)
- Status descriptions
- Auth requirements (always "none — single-tenant, orgId=local")

Undocumented endpoints are not allowed.

---

## Rule of Queue Safety

- Jobs are idempotent
- Workers tolerate restarts mid-job
- Payloads are versioned
- Retries do not duplicate side effects (use job-level dedupe keys)
- Workers run **in-process** — they share the server's lifecycle and config

---

## Rule of Memory Safety

Workers run against very large repositories on bounded local hardware.

- Stream from disk; do not buffer whole files
- Batch writes to graph and storage
- Adaptive memory monitoring is required for long-running phases

---

## Rule of Feature Flags

Major subsystems are toggleable via `@bb/config`. Disabled features degrade gracefully — they do not throw at import time. Conditional features gate **usage**, not the import (see Rule of Module Imports).

---

## Rule of Variable Scope in Branching Pipelines

When a variable is produced in one branch of an `if/else` and consumed after both branches, declare it in the outer scope with a safe default. Guard any usage that is meaningful only in one branch.

---

## Rule of Plans

Plans (under `docs/`) are prose architecture documents. They describe **what and why**, never **how in code**.

- No implementation snippets
- No pseudo-code
- Human-readable, expressive, structural

---

## Rule of New Packages

To add a package:

1. Create `packages/<name>/` with `package.json` (`@bb/<name>`)
2. Add `tsconfig.json` extending `../../tsconfig.base.json`
3. Add it to the root `tsconfig.json` `references` array
4. Declare workspace deps explicitly in `package.json`
5. Create `README.md` describing the package's contract (see below)

A package without `README.md` is not allowed.

---

# Folder Context Rules (`README.md`)

Every package and every major subfolder MUST contain a `README.md`.

`README.md` defines the operational contract:

- Responsibilities
- Public interfaces (exports)
- Data ownership
- Invariants
- External dependencies
- Tier (kernel / infra / strategy / domain / binary)

**Before modifying a folder**, read its `README.md`. **When code changes**, update `README.md` in the same PR. PRs are rejected if `README.md` is missing, stale, or contradicts the code.

---

## Naming Conventions

- Strategies: `BasicFileAnalysisStrategy.ts` (one class per file, `*Strategy.ts`)
- HTTP route builders (server): `githubIndexRoute.ts`, `deleteRoute.ts` (camelCase + `Route.ts`, each exports a `buildXRoute()` factory)
- Commander subcommand entry points (CLI): `IndexCommand.ts`, `IngestCommand.ts` — plain `.ts`, no JSX
- Ink components (CLI forms / pickers): `SetupForm.tsx`, `DeleteSelector.tsx` — `.tsx` because Ink renders JSX to the terminal
- Services: single-responsibility, named for what they do
- Types: live in the package's `types/` or root `index.ts`
- Avoid ambiguous names (`Manager`, `Helper`, `Util`)

---

## Architecture Philosophy

Plumbline-public is **a local research instrument**, not a hosted service.

It exists so a single developer, an OSS community, or a research team can run a durable knowledge engine on their own infrastructure — turning raw repos into a queryable graph and exposing them through MCP. Everything stays on the user's machine; the engine does not phone home.

Design for:

- **Clarity over cleverness**
- **Explicit ownership** — every behavior has exactly one home package
- **Local-first** — no hidden cloud dependencies; the only outbound call is to the user-selected LLM backend (OpenRouter or Ollama)
- **Deterministic pipelines** over heuristics
- **Recoverability** over performance shortcuts
- **Auditability** — every LLM-derived fact is traceable to its source via structured logs and token-usage records in SQLite
- **Long-term maintainability** over rapid hacks

Prefer:

- Explicit systems over implicit magic
- Composition over inheritance
- Provider-agnostic, storage-agnostic, network-agnostic abstractions
- Small files, narrow packages, deep tier discipline
- HTTP boundaries between deployables, never shared in-process state
