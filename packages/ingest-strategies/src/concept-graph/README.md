# `concept-graph` strategy — context

The hypergraph-enrichment counterpart to `flat-folder`. Selected via
`Config.IngestionStrategy = "concept-graph"`.

## Tier

Strategy (lives inside `@bb/ingest-github`; not its own package). Reuses
`@bb/ingest-github`'s pipeline primitives and reaches into
`#src/strategies/flat-folder/...` for the file-local analysis phases.

## What it does

Five phases. Phases 1–3 are reused verbatim from `flat-folder`; phase 4
is new and phase 5 is the headline change:

1. **Scan + classify** — `flat-folder/phases/scan-and-classify.ts`. Walks
   the repo tree, tokenises files, classifies as `small` / `big` /
   `oversized`.
2. **Analyse small + big** — `flat-folder/phases/analyse-small.ts`
   and `analyse-big-files.ts`, run in parallel under the shared
   `Config.LlmConcurrency` limiter. Produces `CondensedFileAnalysis` JSON
   on disk per file.
3. **Backfill** — `flat-folder/backfill/fields.ts`. Fills missing
   extended fields on the in-memory `FileAnalysisCache`.
4. **Store files (no folders / no repo)** — `phases/store-files-no-folders.ts`.
   Writes only `:File` + the reverse-linked `:Keyword` / `:Class` /
   `:Function` / `:Module` nodes. **No `:Folder`, no `:Repo`.** The
   folder-grouping semantic layer is replaced by `:Concept` nodes from
   phase 5.
5. **Per-file MCP enrichment** — `phases/enrich-files.ts` (lands in
   Step 6 of the rollout). One LLM call per file with MCP tools
   (`smart_search`, `keyword_lookup`, `retrieve_file`) bound in-process
   via a synthesised enrichment-tier session context. Emits, in one
   structured response per file: concept attachments (`:HAS_CONCEPT` /
   `:PLAYS_ROLE` / `:BELONGS_TO_DOMAIN`), contracts (`:DEFINES` /
   `:CONSUMES`), test target (`:TESTS`), and any guideposts. Idempotent
   upserts on `(orgId, knowledgeId, slug)`.

## Why no `:Folder` / `:Repo`

In practice the folder/repo summaries rarely earn their cost in queries.
Callers look up files by purpose, by symbol, or by cross-cutting role —
the `:Concept` axis (kinds `role`, `pattern`, `domain`) covers the
"all controllers" / "all auth files" cases far better than
folder-prefix grouping. Dropping phases 5–6 of `flat-folder` saves one
LLM call per folder (often hundreds per repo) and one repo-level call;
that budget shifts into per-file enrichment.

## Reuse without lifting

The phase-1–3 modules live under `flat-folder/phases/` and are imported
here via `#src/strategies/flat-folder/...`. This is intra-package and
permitted by the workspace rules; we deliberately did NOT lift them to
a strategy-neutral `#src/pipeline/phases/` location because:

- The modules are already strategy-neutral in shape (they take a
  manifest, a limiter, a metaPaths handle, and a progress context — none
  of those are flat-folder-specific).
- Lifting would touch every existing flat-folder caller in a working
  pipeline; the regression surface is not worth the architectural
  symmetry.

If a third strategy ever needs the same phases, the lift is still a
mechanical change at that point.

## Enrichment ledger

ConceptGraphStrategy uses the enrichment ledger on `@bb/db`'s
`enrichmentDb` facade (`startEnrichmentRun`, `markFileEnriched`,
`recordEnrichmentFailure`, `completeEnrichmentRun`, `failEnrichmentRun`)
to track per-file resume state across retries. `KnowledgeDoc.state`
stays `PROCESSING` until enrichment reports `Completed`; then the
worker transitions to `PROCESSED`.

## Disk artifacts

Enrichment outputs land at
`~/.plumbline/repos/{knowledgeId}/{commitId}/enrichment/{file-slug}.json`
(one file per enriched file, written when the file's LLM call returns a
schema-valid result). Disk is the audit trail; the canonical graph
state is Neo4j.

## Caps & failure semantics

All caps come from `@bb/config`:

- `Config.EnrichmentMaxToolCallsPerFile` (default 15)
- `Config.EnrichmentMaxIterationsPerFile` (default 8)
- `Config.EnrichmentWallTimeMsPerFile` (default 400000)
- `Config.EnrichmentConcurrency` (default 16 — fans out across files)
- `Config.EnrichmentMaxToolResultChars` (default 20000 — truncation cap
  for each MCP tool result before it goes back to the model)

No fallback. A file that hits any cap is recorded in
`KnowledgeDoc.enrichmentFailures` with a typed reason
(`cap-exceeded | validation-failed | provider-error`); the strategy
throws after all files settle so the queue retry policy kicks in.
Knowledge cannot transition to `PROCESSED` while any file is still
unenriched.
