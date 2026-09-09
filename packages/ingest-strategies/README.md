# @bb/ingest-strategies

The public, provider-agnostic ingestion **strategies**. A strategy turns a
cloned source tree (exposed through a `SourceReader` from `@bb/ingest-core`)
into SQLite rows + Neo4j nodes. It never knows whether the source came from
GitHub, GitLab, or anywhere else.

## Strategies

- **flat-folder** (`createFlatFolderStrategy`) — per-file LLM analysis, folder
  summaries, and a repo summary. The default.
- **concept-graph** (`createConceptGraphStrategy`) — per-file analysis plus a
  per-file MCP enrichment pass emitting `:Concept` / `:Contract` / `:Guidepost`
  hypergraph nodes.
- `pickStrategy(deps)` resolves the active public strategy from
  `Config.IngestionStrategy` (defaults to flat-folder). Any private strategy a
  downstream deployment ships is selected at its own composition root, not here.

## Dependencies

Depends only on `@bb/ingest-core` (contracts, shared phases, primitives) plus
infrastructure packages (`@bb/llm`, `@bb/graph-db`, `@bb/db`, `@bb/mcp`, …).
It does **not** depend on any provider package (`@bb/ingest-github`,
`@plumbline/ingest-gitlab`). Providers and the composition roots depend on it.

Tier: **strategy** (sits above core, below the composition roots).
