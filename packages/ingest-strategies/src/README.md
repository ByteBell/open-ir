# `@bb/ingest-strategies/src`

Source root for the public, provider-agnostic ingestion strategies. A strategy
turns a cloned source tree (exposed through a `SourceReader` from
`@bb/ingest-core`) into SQLite rows + Neo4j nodes. Nothing here knows whether the
source came from GitHub, GitLab, or anywhere else — strategies depend only on
`@bb/ingest-core` and infrastructure packages.

## Layout

- `index.ts` — the package barrel. Re-exports the two strategy factories
  (`createFlatFolderStrategy`, `createConceptGraphStrategy`), `pickStrategy`,
  and the flat-folder pull-driver phases (`analyseChangedFiles`,
  `runSelectiveFolderSummary`, `summariseRepo` + envelope helpers,
  `storePullAnalysis`) that `@bb/ingest-github`'s pull path reuses. This file
  defines the package's entire public surface — nothing outside it should be
  imported across the package boundary.
- `pickStrategy.ts` — `pickStrategy(deps)` resolves the active public strategy
  from `Config.IngestionStrategy` (`flat-folder` default, `concept-graph`
  opt-in), warning and falling back to flat-folder on an unrecognised value.
  Private strategies are **not** handled here — a downstream deployment selects
  its own at its composition root before this picker runs.
- `flat-folder/` — `createFlatFolderStrategy`. Per-file LLM analysis → folder
  summaries → repo summary → graph store. The default strategy. See
  `flat-folder/README.md`.
- `concept-graph/` — `createConceptGraphStrategy`. Per-file analysis plus a
  per-file MCP enrichment pass emitting `:Concept` / `:Contract` / `:Guidepost`
  hypergraph nodes. See `concept-graph/README.md`.

## Public interface

Everything consumers may import is re-exported from `index.ts`:

- `createFlatFolderStrategy` / `FlatFolderStrategyDeps`
- `createConceptGraphStrategy` / `ConceptGraphStrategyDeps`
- `pickStrategy` / `PickStrategyDeps`
- `analyseChangedFiles` / `AnalyseChangedInput` / `AnalyseChangedResult`
- `runSelectiveFolderSummary` / `SelectiveFolderSummaryInput` /
  `SelectiveFolderSummaryResult`
- `summariseRepo`, `persistRepoSummary`, `makeRepoSummaryEnvelope`
- `storePullAnalysis` / `StorePullInput` / `StorePullResult`

Both factories accept `{ fileAnalyzer, progressContextFactory }` and return an
`IngestStrategy` (the contract from `@bb/ingest-core`).

## Dependencies

`@bb/ingest-core` (contracts, shared phases, primitives) plus infrastructure
packages (`@bb/llm`, `@bb/graph-db`, `@bb/db`, `@bb/mcp`, …). **No** provider
package (`@bb/ingest-github`, `@plumbline/ingest-gitlab`) is imported — providers
and the composition roots depend on this package, never the reverse.

## Invariants

- All source-tree access goes through the `SourceReader` port; no strategy
  reads the filesystem directly.
- `index.ts` is the only cross-package import surface; reaching into a strategy
  subfolder from outside the package is forbidden.
- Strategy selection is config-driven and always resolves to a concrete
  strategy — `pickStrategy` never returns undefined.

Tier: **strategy** (sits above `@bb/ingest-core`, below the composition roots).
