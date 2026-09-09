# `@bb/ingest-github/src/strategies/concept-graph/phases`

The concept-graph-specific phase modules. Phases 1–3 are reused from
`flat-folder/phases/` (see that folder's README); the modules here are
the two phases unique to concept-graph: storage without folder/repo
nodes, and per-file MCP-driven enrichment.

## Files

- `store-files-no-folders.ts` — Phase 4. `storeFilesNoFolders({scope,
metaPaths, cache, progressContext?})` writes only `:File` plus the
  reverse-linked `:Keyword` / `:Class` / `:Function` / `:Module` nodes
  in `Config.Neo4jBatchSize`-sized batches via `upsertFileNodesBatch`.
  Skips the `:Repo` and `:Folder` upserts that the flat-folder Phase 7
  emits — the folder/repo semantic layer is replaced by `:Concept`
  nodes from Phase 5. Reports progress on a single fixed-total reporter
  sized by the cache's entry count.
- `enrich-files.ts` — Phase 5 driver. `enrichFiles({scope, metaPaths,
cache, commitId, llmCallContext?, progressContext?})` fans every file
  out under `Config.EnrichmentConcurrency`, starts an enrichment run
  (`startEnrichmentRun`), dispatches `enrichOneFile` per file, records
  each success via `markFileEnriched` and each failure via
  `recordEnrichmentFailure` with a typed
  `cap-exceeded | validation-failed | provider-error` reason, then
  resolves with `{ enrichmentRunId, filesEnriched, filesFailed,
tokenUsage }`. Throws after the run if any file failed (queue retry
  policy then picks the knowledge back up). The only public entry
  point in this folder — Phase 5 is what `concept-graph/index.ts`
  imports.
- `enrich-one-file.ts` — single-file LLM loop. `enrichOneFile(opts)`
  builds the per-file user prompt (with the running
  `EnrichmentRegistry` so the model reuses known concept / contract
  slugs), calls `askLLMWithTools` with the MCP tool catalog +
  executor, enforces the strict `perFileEnrichmentSchema` on the
  returned content, updates the in-memory registry, persists the
  parsed enrichment via `persistEnrichment`, and writes the audit
  artifact via `writeEnrichmentArtifact`. Returns the call's token
  usage. Non-`completed` termination, invalid JSON, and schema
  failures all surface as `LlmError`.
- `persist-enrichment.ts` — `persistEnrichment({scope, relativePath,
enrichmentRunId, parsed})` writes the per-file enrichment into Neo4j:
  upserts every `:Concept` + `HAS_CONCEPT` / `PLAYS_ROLE` /
  `BELONGS_TO_DOMAIN` edge, every `:Contract` + `DEFINES` / `CONSUMES`
  edge, every `:Guidepost` + attach edge, and the optional `:TESTS`
  edge when the file declares a `testTarget`. Idempotent on
  `(orgId, knowledgeId, slug)`.
- `enrichment-registry.ts` — `EnrichmentRegistry` + `KnownEntity`.
  In-memory dedupe map keyed by slug, shared across all parallel
  per-file calls in a run. Holds `{slug, kind, name}` for every
  concept and contract emitted so far so the next file's user prompt
  can name them and the model reuses identifiers instead of
  inventing new ones. `Map.set` is atomic; concurrent writers
  proposing the same entry is a tolerated semantic.

## Execution order

```
(reused) scanAndClassify → analyseSmallFiles + analyseBigFiles → backfill
                                  ↓ (FileAnalysisCache in memory)
storeFilesNoFolders   (writes :File + reverse-linked nodes only)
        ↓
enrichFiles
   └── per file, under Config.EnrichmentConcurrency:
         enrichOneFile
            ├── buildEnrichFileUserPrompt   (sees current registry)
            ├── askLLMWithTools             (MCP tools bound)
            ├── perFileEnrichmentSchema.safeParse
            ├── registry.recordConcepts/Contracts
            ├── persistEnrichment           (Neo4j upserts)
            └── writeEnrichmentArtifact     (audit JSON on disk)
```

## Public interfaces

- `storeFilesNoFolders(input): Promise<StoreFilesNoFoldersResult>` —
  `{ filesWritten }`.
- `enrichFiles(input): Promise<EnrichFilesResult>` —
  `{ enrichmentRunId, filesEnriched, filesFailed, tokenUsage }`.
  Throws `LlmError` after recording per-file failures if any file
  failed.
- `enrichOneFile(opts): Promise<{inputTokens, outputTokens, costUsd}>` —
  used only by `enrich-files.ts`, but exported so the unit suite can
  drive a single file deterministically.
- `persistEnrichment(input): Promise<void>` — used only by
  `enrich-one-file.ts`; exported for the unit suite.
- `EnrichmentRegistry` — used only inside this folder.

## Data ownership

- `enrichFiles` owns the enrichment-run ledger transitions
  (`startEnrichmentRun`, `markFileEnriched`, `recordEnrichmentFailure`,
  `completeEnrichmentRun`, `failEnrichmentRun`).
- `persistEnrichment` owns the Neo4j writes for `:Concept`,
  `:Contract`, `:Guidepost`, and `:TESTS` edges. No other module in
  this folder writes to Neo4j.
- `enrich-one-file.ts` owns the audit JSON written by
  `writeEnrichmentArtifact` (one file per enriched source file under
  `~/.plumbline/repos/{knowledgeId}/{commitId}/enrichment/`).
- `EnrichmentRegistry` is in-memory only; it lives for the duration
  of one `enrichFiles` call and is never persisted.

## Invariants

- LLM output is validated against `perFileEnrichmentSchema` before any
  Neo4j write. Invalid JSON or a schema failure becomes an
  `LlmError("… failed schema validation: …" | "… is not valid JSON: …")`,
  classified as `validation-failed` by the driver.
- `askLLMWithTools` results with `terminationReason !== "completed"`
  become `LlmError("… did not complete: <reason>")`, classified as
  `cap-exceeded`. Any other error class is `provider-error`. No
  fallback path exists — `Config.EnrichmentMaxToolCallsPerFile`,
  `Config.EnrichmentMaxIterationsPerFile`, and
  `Config.EnrichmentWallTimeMsPerFile` are hard caps.
- `throwIfCancelled(knowledgeId)` runs at every per-file dispatch
  boundary. `CancellationError` always propagates out of the driver.
- The registry is read before each per-file prompt is built and
  written after each successful parse. Two files emitting the same
  slug concurrently is safe because the only operation is `Map.set`
  with the first-write-wins guard.
- The driver counts both successes and failures toward the progress
  reporter so the displayed total matches `filesToEnrich.length`.
- Reusable internals (`enrichOneFile`, `persistEnrichment`,
  `EnrichmentRegistry`) are exported only for tests; production
  callers go through `enrichFiles`.

## External dependencies

`@bb/llm` (`askLLMWithTools`, `AskLlmOptions`), `@bb/config`
(`getConfigValue`), `@bb/logger`, `@bb/errors` (`LlmConfigError`,
`LlmError`), `@bb/types` (`Config`, `ConceptKind`, `ContractKind`,
`GuidepostKind`, `EnrichmentFailure`, `EnrichmentFailureReason`,
`NodeScope`, upsert input shapes, edge-kind unions), `@bb/db`
(enrichment-run ledger), `@bb/graph-db` (`conceptsGraph`,
`contractsGraph`, `guidepostsGraph`), sibling modules
`enrichment-schema.ts`, `enrichment-artifact.ts`, `mcp-tool-executor.ts`,
`prompts/enrich-file.ts`, and the intra-package
`pipeline/cancellation.ts`, `pipeline/concurrency.ts`,
`strategies/flat-folder/file-analysis-cache.ts`.

## Tier

Strategy (under the `concept-graph` strategy).
