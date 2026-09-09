# `@bb/neo4j/src` — context

Implementation of `@bb/neo4j`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

## Files

- **[index.ts](index.ts)** — public re-exports. The only entry point
  other packages may import. Exposes the lifecycle (`connectNeo4j`,
  `closeNeo4j`, `pingNeo4j`), schema bootstrap
  (`ensureKnowledgeIndexes`), typed graph helpers (`upsertKnowledgeNode`,
  `setKnowledgeStateInGraph`, `upsertFileNode`), the public read
  primitive `runCypher` (a re-export of the internal `_runCypher` for
  domain-tier consumers), and the integer coercion `toNeo4jInt(n)` for
  any JS number bound into a Cypher `LIMIT`/`SKIP` clause. Plus the
  `PingResult` and `UpsertFileNodeInput` types. Anything not re-exported
  here is internal.
- **[client.ts](client.ts)** — module-scoped `Driver` singleton +
  lifecycle (`connectNeo4j`, `closeNeo4j`), the health probe (`pingNeo4j`,
  via `verifyConnectivity()`), the **internal** `_getDriver()` accessor
  and `_runCypher(query, params)` helper. Reads URI / user / password via
  `getConfigValue(Config.Neo4j*)` from `@bb/config` + `@bb/types`. Throws
  typed errors from `@bb/errors` (`Neo4jConfigError`, `Neo4jConnectError`,
  `Neo4jNotConnectedError`). Also exposes `__resetForTests()` — test seam
  only, never imported by production code.
- **[indexes.ts](indexes.ts)** — `ensureKnowledgeIndexes()` runs two
  schema lists at boot: `CONSTRAINTS` (uniqueness) and `FULLTEXT_INDEXES`
  (the three `idx_*_ft` indexes consumed by `@bb/mcp` retrieval). Both
  are `IF NOT EXISTS`. Tolerant: catches "already exists" /
  "EquivalentSchemaRuleAlreadyExists" failures (Neo4j refuses to create
  a constraint when a plain index already exists on the same
  label+property), logs the skip to stderr, and continues with the
  remaining statements. Operators must drop conflicting plain indexes
  manually if uniqueness guarantees matter.
- **[flatFolderIndexes.ts](flatFolderIndexes.ts)** —
  `ensureFlatFolderIndexes()` covers both the new-schema
  (`:Repo / :Folder`) constraints and the legacy snake_case mirror
  constraints (`:FileNode(knowledge_id, relative_path)`,
  `:FolderNode(knowledge_id, relative_path)`,
  `:RepoSummary(knowledge_id, org_id, branch_name)`,
  `:OrgKeyword(keyword, type, org_id)`). Fulltext indexes follow the
  same pattern: new-schema (`idx_repo_purpose_summary_ft`,
  `idx_folder_purpose_summary_ft`) **plus** the three legacy fulltext
  indexes the chat-mcp reader queries (`idx_filenode_ft`,
  `idx_fileversion_ft`, `idx_orgkeyword_ft`). Same `IF NOT EXISTS` +
  "already exists" tolerance as `ensureKnowledgeIndexes`.
- **[knowledge.ts](knowledge.ts)** — `upsertKnowledgeNode(doc)` MERGEs
  a `:Knowledge` node by `knowledgeId`, setting `sourceKind / sourceUrl /
branch / repoName / state / createdAt / updatedAt` (createdAt only on
  insert). `repoName` is derived once via `deriveRepoName(source)` —
  `owner/repo` (stripped of `.git`) for github sources, `path.basename`
  for local sources, with the original URL as a fallback when parsing
  yields too few segments. `setKnowledgeStateInGraph(knowledgeId, state)`
  is a state-only update used by the worker on each transition.
- **[files.ts](files.ts)** — `upsertFileNode(input)` is the per-file
  write. Performs these sequential operations in one atomic Cypher
  statement (single-shot) or one transaction (batched):
  1. MERGE `:File {knowledgeId, relativePath}`, SET its scalar +
     list props, MERGE the `:HAS_FILE` rel from the parent
     `:Knowledge`. The list props persist the extended `FileAnalysis`
     fields directly on the node (rather than as related nodes):
     `ontologyConcepts`, `businessEntities`, `systemCapabilities`,
     `sideEffects`, `configDependencies`, `integrationSurface`,
     `contractsProvided`, `contractsConsumed`, plus the two
     position-aligned arrays `sectionNames` / `sectionDescriptions`
     and the JSON-stringified `sectionsJson` (carries the full
     `{name, description, start_line?, end_line?}` shape).
  2. Legacy mirror — same statement also MERGEs
     `:FileNode {knowledge_id, relative_path}` with snake_case props
     (full descriptive set + `section_map` = `sectionsJson`,
     `node_id = knowledgeId::relativePath`, `name = basename(path)`,
     `org_id` carried through) and the `:Knowledge -[:HAS_FILE]->
:FileNode` rel.
  3. If `parentFolderPath(relativePath)` is non-null, MERGE
     `:FolderNode -[:CONTAINS_FILE]-> :FileNode` (separate Cypher step
     so the parent's existence doesn't gate the file write).
  4. DELETE all existing `:HAS_KEYWORD / :HAS_CLASS / :HAS_FUNCTION /
:HAS_IMPORT_INTERNAL / :HAS_IMPORT_EXTERNAL` rels so re-runs produce
     a clean entity attachment.
  5. UNWIND keywords (lowercased) → MERGE `:Keyword` + MERGE
     `:HAS_KEYWORD` rel. Same for classes / functions / imports against
     `:Class{signature}` / `:Function{signature}` /
     `:Module{name}` global dedup nodes.
  6. Call `mirrorFileOrgKeywords` /
     `buildOrgKeywordMirrorSteps` from
     [legacyOrgKeywordMirror.ts](legacyOrgKeywordMirror.ts) to clear +
     remerge `:OrgKeyword -[:APPEARS_IN_FILE {frequency: 1}]->
:FileNode` edges across all 14 channels exposed by
     [legacyKeywordChannels.ts](legacyKeywordChannels.ts).

  Each entity attachment runs in its own session (one network round-trip
  per group). Skipped entirely if the corresponding analysis array is
  empty.

  Also exports `deleteFileNodes(knowledgeId, relativePaths)` — `MATCH`
  - `DETACH DELETE` over the live `:File` set for the given paths. No-op
    on empty input. Used by the pull worker to remove files that vanished
    between commits; callers that need history must call
    `snapshotFilesToVersion` first (this only touches `:File`, never
    `:FileVersion`).

- **[folder.ts](folder.ts)** — `upsertFolderNode(input)` /
  `upsertFolderNodesBatch(inputs)` write `:Folder` (camelCase) **and** a
  legacy `:FolderNode {knowledge_id, relative_path}` mirror in the same
  transaction. `level` (depth-from-root, 0-based) and `parentPath` are
  derived in JS by `folderLevel()` / `parentFolderPath()` from
  [pathUtils.ts](pathUtils.ts). The `:CONTAINS_FOLDER` parent→child
  edge is set in a separate step after the batched MERGEs so folders
  can land in any order within a batch.

- **[repo.ts](repo.ts)** — `upsertRepoNode(input)` writes `:Repo`
  (camelCase summary payload) **and** in the same statement MERGEs
  `:Knowledge {knowledgeId}` (the constrained canonical key, so this
  upsert and `upsertKnowledgeNode` converge on one node; also carries
  the `knowledge_id` snake mirror for the chat-mcp reader) and
  `:RepoSummary {knowledge_id, org_id, branch_name}` (snake mirror
  with `architecture`, `data_flow`, `key_patterns`,
  `major_subsystems`, `purpose`, `summary`). Reuses
  `repoNameFromGithubUrl` from [knowledge.ts](knowledge.ts) for
  `repository_name` / `repo_name` / `display_name`.

- **[pathUtils.ts](pathUtils.ts)** — pure helpers used by the legacy
  mirror: `folderLevel(path)`, `parentFolderPath(path)`,
  `basename(path)`. No I/O.

- **[legacyKeywordChannels.ts](legacyKeywordChannels.ts)** — maps a
  `FileAnalysis` payload into the 14 channels the legacy reader
  expects materialized as `:OrgKeyword` nodes: `HAS_KEYWORD`,
  `HAS_CLASS`, `HAS_FUNCTION`, `HAS_IMPORT_INTERNAL`,
  `HAS_IMPORT_EXTERNAL`, `HAS_ONTOLOGY_CONCEPT`,
  `HAS_BUSINESS_ENTITY`, `HAS_SYSTEM_CAPABILITY`, `HAS_SIDE_EFFECT`,
  `HAS_CONFIG_DEPENDENCY`, `HAS_INTEGRATION_SURFACE`,
  `PROVIDES_CONTRACT`, `CONSUMES_CONTRACT`,
  `HAS_DATA_FLOW_DIRECTION`. `expandLegacyOrgKeywordEdges(inputs)`
  flattens per-file inputs into one `:APPEARS_IN_FILE` edge per
  (keyword, type) pair tagged with `frequency: 1`.

- **[legacyOrgKeywordMirror.ts](legacyOrgKeywordMirror.ts)** — Cypher
  helpers that consume the channel expansion above:
  `mirrorFileOrgKeywords(input)` (single-shot: clears existing edges
  then merges new ones), `buildOrgKeywordMirrorSteps(inputs,
updatedAt)` (returns Cypher steps for the batched transaction),
  `recomputeOrgKeywordCountersForKnowledge(orgId, knowledgeId)` and
  `recomputeOrgKeywordCountersForOrg(orgId)` (recount
  `total_frequency` + `file_count` aggregates; per-edge writes set
  `frequency: 1` for the corresponding edge but the counters can drift
  after a partial delete — call the recompute helper once at the end
  of an ingestion run for stricter freshness).

- **[concepts.ts](concepts.ts)** — ConceptGraphStrategy enrichment writes
  for the `:Concept` node and its file-attaching edges. `upsertConcept`
  MERGEs by `(orgId, knowledgeId, slug)`; `kind`/`rationale`/`createdAt`
  are set `ON CREATE` only so the first writer's rationale survives
  subsequent enrichment passes. `attachFileToConcept(input)` dispatches
  on `input.edgeKind` (`HAS_CONCEPT` / `PLAYS_ROLE` /
  `BELONGS_TO_DOMAIN`) — Cypher cannot parameterise the relationship
  type in MERGE, so each variant has its own static query.
  `upsertTestsEdge` lives here too (file-to-file `:TESTS`) because it
  is an enrichment-time discovery, not part of the canonical file write
  in `files.ts`. Every node and edge carries `enrichmentRunId`.
- **[contracts.ts](contracts.ts)** — `:Contract` node + file-attaching
  edges (`DEFINES` / `CONSUMES`). Same merge policy and dispatch
  pattern as `concepts.ts`.
- **[guideposts.ts](guideposts.ts)** — `:Guidepost` node + polymorphic
  `:ABOUT` edge. `attachGuidepost` rejects ambiguous input: exactly one
  of `targetFileRelativePath` / `targetConceptSlug` /
  `targetContractSlug` must be set.
- **[conceptGraphIndexes.ts](conceptGraphIndexes.ts)** —
  `ensureConceptGraphIndexes()` runs the uniqueness constraints +
  fulltext indexes for `:Concept` / `:Contract` / `:Guidepost`.
  Tolerant of pre-existing schema in the same way as
  `ensureKnowledgeIndexes()` / `ensureFlatFolderIndexes()`.
- **[fileVersions.ts](fileVersions.ts)** — `snapshotFilesToVersion`
  copies every live `:File` into a `:FileVersion(commitHash)` snapshot
  before a pull overwrites the live set. The SET clause must mirror
  the property list written by `upsertFileNode` (the scalar core
  fields plus all extended list properties — `ontologyConcepts`,
  `sideEffects`, `configDependencies`, …, `sectionNames`,
  `sectionDescriptions`, `sectionsJson`) so the version history is
  lossless. When adding a new property to `:File`, also add it to the
  SET clause here, or version snapshots will silently drop it.

  The same Cypher additionally sets the legacy snake_case property
  set on the same `:FileVersion` node (`knowledge_id`,
  `relative_path`, `commit_hash`, `committed_at`, `change_type`,
  `org_id`, `section_map`, `business_context`,
  `data_flow_direction`, the 8 extended array props), MERGEs
  `:FileNode -[:HAS_VERSION]-> :FileVersion` (snake source for the
  reader's commit-pinned queries) in addition to the existing
  `:File -[:HAS_VERSION]-> :FileVersion` (camel source), and copies
  every `:OrgKeyword -[:APPEARS_IN_FILE]-> :FileNode` edge onto the
  new `:FileVersion` with `commit_hash` stamped on the edge so
  commit-pinned `keyword_lookup` queries find versioned hits.

## Module dependency graph

```
client.ts                  → neo4j-driver, @bb/config (getConfigValue), @bb/types (Config),
                             @bb/errors (Neo4j* error classes)
indexes.ts                 → client.ts (_runCypher)
flatFolderIndexes.ts       → client.ts (_runCypher)
pathUtils.ts               → (pure functions, no deps)
knowledge.ts               → client.ts (_runCypher), @bb/types (KnowledgeDoc, KnowledgeSource, KnowledgeState), node:path
repo.ts                    → client.ts, knowledge.ts (repoNameFromGithubUrl)
folder.ts                  → client.ts, pathUtils.ts (folderLevel, parentFolderPath), repo.ts (NodeScope type)
files.ts                   → client.ts, pathUtils.ts (basename, parentFolderPath),
                             legacyOrgKeywordMirror.ts (mirrorFileOrgKeywords,
                             buildOrgKeywordMirrorSteps), @bb/db-core (FileAnalysis type)
fileVersions.ts            → client.ts
legacyKeywordChannels.ts   → @bb/db-core (FileAnalysis type)
legacyOrgKeywordMirror.ts  → client.ts, legacyKeywordChannels.ts, @bb/db-core (FileAnalysis type)
index.ts                   → re-exports the public surface from client.ts + indexes.ts +
                             flatFolderIndexes.ts + knowledge.ts + files.ts + repo.ts +
                             folder.ts + fileVersions.ts + concepts.ts + contracts.ts +
                             guideposts.ts + legacyOrgKeywordMirror.ts (counter helpers only)
```

No cycles. `client.ts` is the single root all helpers compose against.

## Invariants enforced here

- **Connect is idempotent and concurrent-safe.** `connectNeo4j()`
  short-circuits if `driver !== null`; concurrent callers await the same
  in-flight `connecting` promise.
- **Close is graceful and re-entrant.** `closeNeo4j()` clears the cached
  driver before awaiting `driver.close()` so a subsequent
  `connectNeo4j()` cleanly re-establishes; calling twice is a no-op.
- **Sessions are short-lived.** `_runCypher` opens a session per call
  and closes in `finally`. No session leaks even on driver-side errors.
- **Schema bootstrap is best-effort.** `ensureKnowledgeIndexes` logs +
  continues on conflicts; the worker still runs (uniqueness is desirable
  but not load-bearing for our single-process MERGE writes).
- **Stale relationships are pruned before re-attaching.** `upsertFileNode`
  always DELETEs the four relationship types before MERGEing fresh ones;
  changing analysis between runs doesn't accumulate dead pointers.
- **No env reads.** Only `getConfigValue(Config.Neo4j*)` provides creds.
- **Errors carry typed metadata.** Construction sites use the catalog
  in `@bb/errors` — never inline `new Error(string)`.
- **Cypher `LIMIT`/`SKIP` params are integers.** The JS driver maps
  bare `number` to Cypher `Float`, which Neo4j 5 rejects in `LIMIT`/
  `SKIP`. Callers must wrap any numeric bound used in those clauses
  with `toNeo4jInt(n)`. The wrapper returns a driver `Integer` that the
  driver serialises correctly.

## Adding a helper

Follow the recipes in [../README.md](../README.md) under _How to extend_.
New files live as flat `src/<name>.ts` (the repo ESLint rule forbids
parent traversal — keep `src/` flat). Helpers compose `_runCypher`;
never expose the raw `Driver` to callers.
