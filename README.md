<picture>
  <source media="(prefers-color-scheme: dark)"  srcset=".github/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/banner-light.svg">
  <img alt="Plumbline — local-first code intelligence" src=".github/banner-light.svg">
</picture>

# Plumbline

**Local-first code intelligence.** Plumbline reads every file in your repository, extracts
what each one is _for_, and stores the result as a queryable knowledge graph your coding
agent searches over MCP — running entirely on your machine, bound to `127.0.0.1`.

[![License](https://img.shields.io/badge/license-AGPL--3.0%20%2B%20non--commercial-A8762B)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-streamable%20http%20%2B%20sse-1A211E)](#connect-an-mcp-client)
[![Binds](https://img.shields.io/badge/binds-127.0.0.1%20only-55605B)](#who-this-is-for)

> **On the name:** Plumbline is the project; `plumbline` is the command it installs.
> Every CLI invocation, container name, and config path below uses `plumbline` — that is
> the real binary, not a typo.

## The problem

Coding agents read whole files into the context window. On a real repository that is both
expensive and lossy — the agent spends its budget on files it did not need and still misses
the one that mattered, because nothing told it where to look.

Plumbline gives it somewhere to look. Every file is analyzed once for its purpose, summary,
business context, classes, functions and keywords. That metadata becomes a Neo4j graph; the
raw content sits in a local SQLite database beside it. Retrieval fuses both — semantic meaning _and_
structural relationships — so the agent asks a question instead of reading a directory.

## Quickstart

> Looking for the full CLI reference? Every `plumbline` subcommand, flag, and option lives in **[commands.md](commands.md)**. The Quickstart below is the minimum sequence from zero to a queryable graph.

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 — runtime + workspace manager.
- [Docker](https://www.docker.com/) — for the local Neo4j container `plumbline boot` brings up. The document store and job queue are both SQLite and need no container.
- An LLM backend — either an [OpenRouter](https://openrouter.ai) API key (default) or a local [Ollama](https://ollama.com) model. Every per-file analysis call goes through the one you pick.

### Install

One command — checks prerequisites, clones the repo, installs dependencies, and links the `plumbline` binary:

```bash
curl -fsSL https://raw.githubusercontent.com/ByteBell/Plumbline/main/install.sh | bash
```

Verify with `plumbline --help`. (Manual install steps are in [commands.md](commands.md).)

### Fastest path: `plumbline setup`

```bash
plumbline setup
```

One interactive command does everything the manual steps below automate: picks your LLM provider, auto-fills and boots the local stack, optionally indexes a repo (handling private-repo tokens and branch selection), and **auto-wires the MCP endpoint into your editor**. See [SETUP.md](SETUP.md) for the full walkthrough.

The sections below are the manual, step-by-step equivalent — useful if you want to configure each piece yourself or bring your own infrastructure.

### Configure

Two values Plumbline needs — your OpenRouter API key and model. Set them headlessly:

```bash
plumbline set openrouter-api-key sk-or-…
plumbline set openrouter-model anthropic/claude-sonnet-4.6
```

Or skip this step and run `plumbline boot` straight away — on an interactive terminal it opens a setup form to collect these on first run. Running `plumbline set` with no arguments opens the same form at any time.

There is no `.env` file anywhere. `~/.plumbline/config.json` (mode `0600`) is the single source of truth, and `plumbline set` is the only sanctioned way to write to it. If you already run Neo4j and don't want the Docker stack, see [Bring your own infrastructure](#bring-your-own-infrastructure) below.

### Boot

```bash
plumbline boot
```

What happens, in order:

1. **Pre-flight check** — verifies both OpenRouter keys are set. If either is blank and you're in an interactive terminal, Plumbline opens a setup form so you can enter them on the spot, then continues. In a non-interactive context (CI, piped input) it prints the exact `plumbline set …` commands and exits.
2. **Auto-fill** — fills any missing infra config keys with local-Docker defaults; generates a Neo4j password if one isn't set.
3. **Stack up** — `docker compose up -d` brings up `plumbline-neo4j` (a named volume — data persists across reboots). SQLite needs no container; the documents live at `~/.plumbline/data.sqlite` and the queue at `~/.plumbline/queue.db`.
4. **Health gate** — polls `docker compose ps` until all three services report `healthy`.
5. **Server up** — spawns `plumbline-server` (HTTP on `127.0.0.1:8080`, MCP at `/mcp`).

First boot pulls images and can take a couple of minutes. Subsequent boots are fast.

### Index a repo

```bash
plumbline index https://github.com/anthropics/claude-code
# private repo: add --token <github-pat>; never paste the PAT positionally
plumbline ls   # watch state: CREATED → QUEUED → INGESTED → PROCESSING → PROCESSED
```

When the row reads `PROCESSED`, the graph is fully populated and the MCP tools will return results for that repo. Local directories work too: `plumbline ingest /path/to/source-tree`.

### Connect an MCP client

Easiest: **`plumbline mcp install`** auto-detects your installed tools — Claude Code, Cursor, Claude Desktop, Windsurf, VS Code — and writes the correct MCP entry into each one's config (the JSON shape differs per tool; the command handles that and backs up the file first). `plumbline setup` runs this for you on first boot.

To wire Claude Code by hand:

```bash
claude mcp add --transport http plumbline http://127.0.0.1:8080/mcp
```

Or add this under the `mcpServers` key of Claude Desktop's config (or Cursor's `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "plumbline": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

The server registers `smart_search`, `keyword_lookup`, and `retrieve_file`, plus a bundled skill at `plumbline://skills/index` that the client can fetch and install once per session for the recommended workflow.

## What Plumbline does

You point `plumbline` at a repo. It clones the source, walks every file, and for each file calls an LLM (via OpenRouter) to extract a structured `FileAnalysis`: a one-paragraph **purpose**, a longer **summary** of what the file does and how it fits the architecture, a **business context** line tying it to the product domain, plus the file's classes, functions, keywords, and imports.

Those outputs are persisted into two stores:

- **Neo4j** receives a `:File` node enriched with `purpose`, `summary`, `businessContext`, `language`, `sha`, and `sizeBytes`, linked via `:HAS_CLASS`, `:HAS_FUNCTION`, `:HAS_KEYWORD`, `:HAS_IMPORT_INTERNAL`, and `:HAS_IMPORT_EXTERNAL` to deduplicated child nodes shared across the whole graph. Fulltext indexes cover purpose+summary, business context, keyword names, and class/function signatures.
- **SQLite** receives the raw file content, language, SHA256, and the full `FileAnalysis` JSON for cite-back and exact retrieval. It is a single file at `~/.plumbline/data.sqlite` — no server, no container.

LLM clients then query that graph through three MCP tools — `smart_search`, `keyword_lookup`, `retrieve_file` — which together cover fused semantic + structural search, reverse entity-to-file lookup, and targeted content reads. They let an agent answer questions like _"Which files implement our retry/backoff policy and where is it configured?"_ without reading the entire repo into context.

```mermaid
flowchart LR
    CLI["plumbline CLI / TUI"] -- HTTP --> Server["plumbline-server<br/>(Express)"]
    Client["MCP-capable LLM client<br/>Claude Code, Cursor, …"] -- MCP --> Server
    Server -- enqueues --> Q["SQLite-backed in-process worker"]
    Q --> Strategy["IngestionStrategy<br/>per-file LLM"]
    Strategy -- LLM call --> OR["OpenRouter"]
    Strategy -- raw + analysis --> Sqlite[("SQLite")]
    Strategy -- enriched node --> Neo[("Neo4j")]
    Server -. retrieval .-> Sqlite
    Server -. retrieval .-> Neo
```

## Who this is for

- **Solo engineers and small teams** who want a Claude / Cursor / Continue session to _actually_ know their codebase — not just whatever the tool can fit in a context window — without sending source to a third party.
- **OSS communities and academic research groups** who need a durable, reproducible code-knowledge index they can re-index from a single command.
- **Anyone running an MCP-capable agent on a private codebase** where compliance, IP, or just personal preference rules out hosted RAG-over-your-repo SaaS.

It is **not** a hosted product, not a chat UI, and not a multi-tenant platform. There is exactly one tenant — `orgId="local"` — and the server binds to `127.0.0.1`. If you want hosted, multi-tenant, or commercial-use rights, see the [Enterprise](#enterprise) section.

## How it works

### Ingest

`plumbline index <url>` (or `plumbline ingest <path>`) submits a job to an in-process SQLite-backed queue. The worker dispatches to an `IngestionStrategy` — today, `BasicFileAnalysisStrategy` ([packages/ingest-github/src/BasicFileAnalysisStrategy.ts](packages/ingest-github/src/BasicFileAnalysisStrategy.ts)). It clones the repo to `~/.plumbline/repos/<knowledgeId>/`, walks every file, runs a per-file OpenRouter call, and persists raw content to SQLite + the enriched node to Neo4j.

The per-file LLM call returns a single JSON object with this shape:

```jsonc
{
  "purpose": "Why this file exists. Max ~300 tokens.",
  "summary": "What it does, key patterns, architecture role. Max ~600 tokens.",
  "businessContext": "Product/domain impact. 2–3 lines, max ~100 tokens.",
  "classes": ["ExactName (~L3-29): What it represents", "..."],
  "functions": ["exact_name (~L42-58): Primary responsibility", "..."],
  "keywords": ["domain-term-1", "domain-term-2", "..."],
  "importsInternal": ["./relative/paths.ts", "..."],
  "importsExternal": ["express", "neo4j-driver", "..."],
}
```

`classes` and `functions` carry approximate line ranges so `retrieve_file` can later pull the right slice without re-reading the whole file. **Re-indexing is diff-aware**: on `plumbline pull`, the strategy compares each file's SHA256 to the prior `:File.sha` and only re-analyses files whose hash changed. LLM cost is proportional to actual code churn, not to repo size.

### Graph shape

```mermaid
graph LR
    K[":Knowledge"]
    F[":File<br/>purpose, summary,<br/>businessContext"]
    KW[":Keyword"]
    C[":Class"]
    Fn[":Function"]
    M[":Module"]
    K -- HAS_FILE --> F
    F -- HAS_KEYWORD --> KW
    F -- HAS_CLASS --> C
    F -- HAS_FUNCTION --> Fn
    F -- HAS_IMPORT_INTERNAL --> M
    F -- HAS_IMPORT_EXTERNAL --> M
```

One `:Knowledge` node per indexed repo owns its `:File` nodes. Each `:File` carries `purpose`, `summary`, `businessContext`, `language`, `sha`, `sizeBytes`, and a `relativePath` unique within its `knowledgeId`. From every file, the five `:HAS_*` edges link to deduplicated `:Keyword`, `:Class`, `:Function`, and `:Module` nodes that are global across the whole graph — the same library, the same exported function, the same domain term resolves to one node no matter how many repos reference it. Constraints make `(knowledgeId, relativePath)` unique on `:File`; fulltext indexes back the natural-language search side. Source: [packages/neo4j/src/files.ts](packages/neo4j/src/files.ts), [packages/neo4j/src/indexes.ts](packages/neo4j/src/indexes.ts).

There are no cross-file call edges in the current schema — that's a deliberate tradeoff for ingestion simplicity and language-agnostic ingest. Future strategies will add them, plugged in behind the same `IngestionStrategy` interface.

### Retrieval

Three MCP tools, registered at `http://127.0.0.1:8080/mcp`:

- **`smart_search(query, k=20)`** — fused six-channel search across File `purpose`/`summary`, `businessContext`, paths, keyword names, class/function signatures, and module imports. Returns deduplicated, ranked top-K files with folder clustering. Use first.
- **`keyword_lookup(term)`** — reverse lookup. A search term resolves to all matching named entities (keywords, classes, functions, module names) and the files linked to each.
- **`retrieve_file`** — three operations: `metadata` (purpose, summary, businessContext, classes/functions with line ranges, imports), `content` (read specific line ranges or search within one file with surrounding context), `bulk_search` (parallel scan of up to 50 files for a string).

```mermaid
flowchart TD
    Q["Question from agent"] --> SS["smart_search"]
    SS --> KL["keyword_lookup<br/>(optional)"]
    SS --> RM["retrieve_file metadata<br/>→ class/function line ranges"]
    KL --> RM
    RM --> RC["retrieve_file content<br/>→ exact line slice"]
    RC --> A["Cited answer"]
```

Most well-formed code questions resolve in 2–4 tool calls. No re-clone, no full-file dumps, no embeddings round-trip.

## Day-to-day commands

| Command                                                       | Purpose                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `plumbline setup`                                             | Interactive first-run wizard: provider, boot, optional index, MCP auto-install.     |
| `plumbline ls`                                                | List indexed knowledge entries with state.                                          |
| `plumbline stats`                                             | Ingestion totals, per-repo breakdown, per-commit token usage.                       |
| `plumbline mcp install`                                       | Auto-detect installed editors and register the MCP endpoint in their config.        |
| `plumbline mcp stats`                                         | MCP usage: input/output tokens, monthly breakdown.                                  |
| `plumbline pull`                                              | Re-index a previously-added GitHub repo at branch HEAD (diff-aware).                |
| `plumbline delete`                                            | Picker; cancels jobs, drops the Knowledge subgraph from Neo4j, removes SQLite rows. |
| `plumbline shutdown`                                          | Stop the server. Docker keeps running.                                              |
| `plumbline boot`                                              | Warm restart.                                                                       |
| `docker compose -f infra/docker/docker-compose.yml down [-v]` | Stop containers (and optionally drop volumes — destroys all indexed data).          |

Full reference, including every flag and option: [commands.md](commands.md).

## Bring your own infrastructure

By default, `plumbline boot` provisions a local Docker stack (`plumbline-neo4j`) with auto-generated credentials. The document store and the queue are SQLite — local files, never containers. If you already run Neo4j (or want to use a managed service), set the connection details before booting and the Docker step is skipped:

```bash
plumbline set neo4j-uri      bolt://host:7687
plumbline set neo4j-user     neo4j
plumbline set neo4j-password <your-password>
```

Docker is not required on the host in this mode. See the [Configuration reference](#configuration-reference) for the full key list.

## Architecture at a glance

A single Bun-built Express daemon, `plumbline-server`, hosts the ingestion HTTP routes, the MCP transport (Streamable HTTP + SSE), and the queue workers all in-process. The CLI is a thin Ink/React TUI that only ever talks HTTP to that daemon — it never touches SQLite or Neo4j directly. Workers run in the server's lifecycle; there is no separate worker fleet.

For the full PRD — package tiers, state machine, HTTP route catalogue, verification checklist, distribution strategy — see [docs/arch.md](docs/arch.md).

## Configuration reference

Settings live in `~/.plumbline/config.json` and are written exclusively by `plumbline set <key> <value>` (or by first-run auto-fill on `plumbline boot`). Keys:

| Key                  | Purpose                                  | Default                        |
| -------------------- | ---------------------------------------- | ------------------------------ |
| `openrouter-api-key` | API key for per-file LLM analysis        | _(required, blank by default)_ |
| `openrouter-model`   | OpenRouter model slug used for analysis  | _(required)_                   |
| `sqlite-path`        | Path to the SQLite document store        | `~/.plumbline/data.sqlite`     |
| `neo4j-uri`          | Neo4j Bolt URI                           | `bolt://localhost:7687`        |
| `neo4j-user`         | Neo4j auth user                          | `neo4j`                        |
| `neo4j-password`     | Neo4j auth password                      | _(generated on first boot)_    |
| `queue-db-path`      | Path to the SQLite job queue             | `~/.plumbline/queue.db`        |
| `server-port`        | Local HTTP/MCP port                      | `8080`                         |
| `concurrency-github` | Concurrent files analysed per GitHub job | tuned per box                  |
| `log-level`          | Winston log level                        | `info`                         |
| `log-retention-days` | Daily log retention                      | `14`                           |

If a required setting is missing, Plumbline either opens the setup form (interactive terminal) or prints the exact `plumbline set …` command and refuses to boot (non-interactive). It never silently reads `process.env`.

## Why this design — research grounding

> Comparing Plumbline to PageIndex, GitNexus, GraphRAG, Sourcegraph, or Augment Code? See **[comparison.md](comparison.md)** for a side-by-side feature table and pros / cons of each.

Plumbline's shape — _build a code graph at ingest time, enrich every node with LLM-derived structured semantics, then serve retrieval against the joined surface_ — tracks a converging body of recent work showing that purely structural retrieval (AST / call-graph) and purely semantic retrieval (embeddings) each leave large performance on the table, and that combining them at indexing time unlocks the gains.

**Graphs beat flat retrieval for code.** Repository-level graphs from AST + imports + call structure consistently outperform flat embedding retrieval on real engineering tasks.

- RepoGraph ([2410.14684](https://arxiv.org/abs/2410.14684), ICLR 2025) — +32.8% on SWE-bench.
- CodexGraph ([2408.03910](https://arxiv.org/abs/2408.03910), NAACL 2025) — agents query a code graph DB; beats similarity-only retrieval.
- CGM ([2505.16901](https://arxiv.org/abs/2505.16901)) — graph + node semantics; 43% on SWE-bench Lite.
- Citation-Grounded Code Comprehension ([2512.12117](https://arxiv.org/abs/2512.12117)) — argues LLM-only and embedding-only both fail; hybrid wins.

**LLM-generated semantic enrichment closes the vocabulary gap.** Identifiers and call edges don't capture intent — natural-language summaries on each node let retrieval match what a developer _means_, not just what the code _spells_.

- Tram ([2305.11074](https://arxiv.org/abs/2305.11074), ACL 2023) — semantic enrichment beats flat sentence-level retrieval.
- LLM Agents Improve Semantic Code Search ([2408.11058](https://arxiv.org/abs/2408.11058)) — LLM-injected metadata improves embedding-based retrieval.
- Knowledge-Graph-Based Repo-Level Code Generation ([2505.14394](https://arxiv.org/abs/2505.14394)) — graph captures structure; LLM context fills semantic gaps.
- Sense and Sensitivity ([2505.13353](https://arxiv.org/abs/2505.13353)) — lexical and semantic recall are different capabilities; supports the `summary` (semantic) vs SQLite raw (lexical) split.

**Structured summaries and hierarchy beat blob summarization.** Explicit fields — purpose, inputs, outputs, business context — aggregated bottom-up let retrieval match at the right level of abstraction. This maps directly onto Plumbline's `purpose` / `summary` / `businessContext` schema.

- Hierarchical Repo-Level Code Summarization for Business Applications ([2501.07857](https://arxiv.org/abs/2501.07857), ICSE LLM4Code 2025) — closest motivational match: structured per-unit summaries aggregated to file/package level, grounded in business context.
- Beyond Function Level ([2502.16704](https://arxiv.org/abs/2502.16704)) — class/repo context in summaries beats function-only.
- Code-Craft ([2504.08975](https://arxiv.org/abs/2504.08975)) — closest published peer; bottom-up LLM summaries from a code graph; +82% top-1 retrieval precision on 7,531 functions.
- Hierarchical Summarization (Springer 2025) — project/dir/file summaries at indexing time; Pass@10 of 0.89 on real Jira issues, beats flat retrieval and standard RAG.

**Hybrid structure + semantics, served as memory.** The most recent work converges on serving the joined graph through a memory-style retrieval interface — exactly what MCP gives us.

- Codebase-Memory ([2603.27277](https://arxiv.org/abs/2603.27277)) — MCP-served knowledge graph with LLM-derived metadata; reports 10× token reduction.

The design choices follow directly: each `:File` node carries LLM-generated semantics alongside `:HAS_CLASS` / `:HAS_FUNCTION` / `:HAS_KEYWORD` / `:HAS_IMPORT_*` edges (structure), and the three MCP tools fuse both surfaces at query time.

## Enterprise

Plumbline — `Plumbline-public` in the [LICENSE](LICENSE) text — is the OSS edition. ByteBell also offers a separately-licensed **Enterprise** edition for organizations that need a commercial-use grant, hardening, and direct support. Enterprise typically includes:

- A commercial-use grant covering use by or on behalf of for-profit entities, including SaaS deployments and revenue-generating applications.
- Hardened multi-tenant deployment patterns, SSO / SCIM, audit logging, and data-isolation guarantees.
- Additional ingestion strategies (cross-file call graphs, dependency-graph extraction, PDF and design-doc ingestion) and additional MCP tools.
- Access to the managed ByteBell knowledge surface and connectors to internal sources (Confluence, Jira, Notion, GitHub Enterprise, …).
- Engineering support and SLAs for production deployments.

To discuss Enterprise licensing, evaluation, or services, contact `team@bytebell.ai`.

## Contributing

Hooks, commit conventions, and pre-push gates are documented in [contributing.md](contributing.md). Architectural rules — file-size limits, tier boundaries, the `README.md` requirement, the Bun-only and OpenRouter-only constraints — live in [CLAUDE.md](CLAUDE.md) and apply to every PR.

## License

Plumbline is released under **AGPL-3.0 with an additional non-commercial use clause** — see [LICENSE](LICENSE) for the authoritative text. Personal, academic, research, and non-profit use are unrestricted under AGPL-3.0 (network-copyleft applies). **Commercial use** is governed by license terms and is covered by the [Enterprise edition](#enterprise) (`team@bytebell.ai`). The running server itself does **not** verify a license; governance is by license terms, not by code. The server is meant for local single-tenant use — no remote network surface; everything binds to `127.0.0.1`.
