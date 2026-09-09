# `@bb/neo4j` — context

## Tier

Infrastructure. Depends on Kernel (`@bb/types` for `Config` and
`KnowledgeState`, `@bb/errors` for typed error classes) and Infrastructure
sibling (`@bb/config` for `Config.Neo4jUri / Neo4jUser / Neo4jPassword`).
May be imported by Strategy (`@bb/queue` workers via `@bb/ingest-github`),
Domain, and Binaries — never by `@bb/cli`.

For v1 this single package owns **both** the driver primitives (lifecycle,
ping, raw cypher) **and** the typed graph helpers (knowledge nodes, file
nodes, indexes). The arch.md tier diagram reserves a separate `@bb/graph`
for the typed query layer; we collapsed for v1 to keep boilerplate low.
When `@bb/mcp` retrieval lands and needs to read the same graph, the
helpers will graduate into a dedicated `@bb/graph` package and `@bb/neo4j`
shrinks to driver-only — mirroring the `@bb/queue-core` + `@bb/queue` split.

## Responsibility

The package owns:

- A single shared `neo4j-driver` `Driver` instance (lazy, idempotent
  connect; graceful close)
- A health probe (`pingNeo4j`) backed by `verifyConnectivity()`
- An internal `_runCypher(query, params)` helper that runs a query in a
  one-shot session and returns rows as plain objects
- Schema bootstrap (`ensureKnowledgeIndexes`) — uniqueness constraints
  for `:Knowledge / :File / :Keyword / :Class / :Function / :Module`,
  plus four fulltext indexes that power `@bb/mcp` retrieval
  (`idx_file_purpose_summary_ft`, `idx_file_business_context_ft`,
  `idx_keyword_name_ft`, `idx_symbol_signature_ft`). Tolerant of
  pre-existing indexes (Neo4j
  refuses constraints when a matching plain index already exists; we
  log + skip)
- Knowledge-node CRUD (`upsertKnowledgeNode`, `setKnowledgeStateInGraph`,
  `deleteKnowledgeGraph`). `deleteKnowledgeGraph` runs two
  `DETACH DELETE` cypher statements: one to remove every `:File` for
  that `knowledgeId` (which transitively detaches keyword / class /
  function / import edges), and one to remove the `:Knowledge` node
  itself. Called by the server's `DELETE /api/v1/repos/:knowledgeId`
  route.
- File-node CRUD (`upsertFileNode`, `upsertFileNodesBatch`) — composes
  the per-file relationships (`:HAS_KEYWORD / :HAS_CLASS / :HAS_FUNCTION
/ :HAS_IMPORT_INTERNAL / :HAS_IMPORT_EXTERNAL`), clearing stale
  relationships before re-attaching for re-runs. The two-`:HAS_IMPORT_*`
  split mirrors kube-package's distinction between relative imports and
  external packages — downstream MCP queries can ask "which files
  import this internal module" vs "which files import this external
  package" cleanly. The `*Batch` variant lands an arbitrary number of
  files in **one transaction** via Cypher `UNWIND` — same Cypher shape,
  wrapped with an outer UNWIND so 50+ files cost the same 12 Cyphers a
  single file used to cost.
- Folder-node CRUD (`upsertFolderNode`, `upsertFolderNodesBatch`) —
  same shape as file CRUD; batched variant for bulk indexing.
- Read-side search queries (`src/search/`) implementing
  `IGraphSearchRepository`: `runSmartSearchChannel` (8 channels over
  fulltext indexes), `keywordLookup` (keyword / class / function / module
  reverse lookup), `listKnowledgeBases`, `fetchFileMetadata`,
  `fetchRepoNames`. All Cypher that `@bb/mcp` previously embedded inline
  lives here now. Composed onto `Neo4jGraphProvider.search` and exposed
  to MCP via `searchGraph` in `@bb/graph-db`.
- Repo-node CRUD (`upsertRepoNode`) — writes a `:Repo` carrying the
  per-repo summary payload (purpose, dataFlow, keyPatterns, etc.) and
  in the same transaction MERGEs a snake_case `:Knowledge` mirror plus
  the `:HAS_REPO` edge. The mirror carries both `knowledge_id` (snake)
  and `knowledgeId` (camel) on the same node so the chat-mcp reader
  (`MATCH (k:Knowledge {org_id})`) and `upsertKnowledgeNode` (MERGE on
  `knowledgeId`) both converge on a single node.
- **Legacy snake_case mirror** — every primary writer (`upsertRepoNode`,
  `upsertFolderNode(sBatch)`, `upsertFileNode(sBatch)`,
  `snapshotFilesToVersion`) additionally produces the snake_case schema
  the chat-mcp reader expects. Each upsert is atomic per call:
  - `:RepoSummary {knowledge_id, org_id, branch_name, architecture,
data_flow, key_patterns, major_subsystems, purpose, …}` linked from
    `:Knowledge` via `:HAS_REPO_SUMMARY`.
  - `:FolderNode {knowledge_id, relative_path, org_id, purpose, summary,
level, dependency_graph, …}` linked from `:Knowledge` via
    `:HAS_FOLDER` and from its parent `:FolderNode` via
    `:CONTAINS_FOLDER` (the parent edge is set in a separate step within
    the same batched transaction so folder ordering doesn't matter).
    `level` and parent path are derived in JS by `folderLevel()` /
    `parentFolderPath()` from [`pathUtils.ts`](./src/pathUtils.ts).
  - `:FileNode {knowledge_id, relative_path, org_id, node_id (=
knowledgeId::relativePath), name, language, purpose, summary,
business_context, section_map (JSON string), data_flow_direction,
ontology_concepts, business_entities, system_capabilities,
side_effects, config_dependencies, integration_surface,
contracts_provided, contracts_consumed, keywords, classes,
functions, imports_internal, imports_external, …}` linked from
    `:Knowledge` via `:HAS_FILE` and from its parent `:FolderNode` via
    `:CONTAINS_FILE`.
  - `:OrgKeyword {keyword, type, org_id, content_type: 'code',
total_frequency, file_count}` materialized from
    [`legacyKeywordChannels`](./src/legacyKeywordChannels.ts) (14
    channels: classes / functions / keywords / imports / 8 array props /
    `dataFlowDirection`), with one
    `:OrgKeyword-[:APPEARS_IN_FILE {frequency: 1, org_id,
commit_hash}]->(:FileNode | :FileVersion)` edge per (keyword, type)
    pair. The mirror lives in
    [`legacyOrgKeywordMirror.ts`](./src/legacyOrgKeywordMirror.ts).
    Aggregate counters (`total_frequency`, `file_count`) are maintained
    per-edge during ingestion; call
    `recomputeOrgKeywordCountersForKnowledge` (exported) at the end of
    a strategy run if you need stricter freshness after batch deletes.
  - `:FileVersion` carries both camelCase and snake_case property sets
    on the same node. `snapshotFilesToVersion` adds `:FileNode
-[:HAS_VERSION]-> :FileVersion` (snake source) alongside the
    existing `:File -[:HAS_VERSION]-> :FileVersion` (camel source) and
    materializes `:OrgKeyword -[:APPEARS_IN_FILE {commit_hash}]->
:FileVersion` edges from whatever `:OrgKeyword` already points to
    the corresponding `:FileNode`.

  The legacy reader keys all of these by snake_case `org_id` /
  `knowledge_id` / `relative_path`; the constraints are registered in
  [`flatFolderIndexes.ts`](./src/flatFolderIndexes.ts) (uniqueness on
  `(FileNode.knowledge_id, relative_path)`,
  `(FolderNode.knowledge_id, relative_path)`,
  `(RepoSummary.knowledge_id, org_id, branch_name)`,
  `(OrgKeyword.keyword, type, org_id)`) along with three fulltext
  indexes (`idx_filenode_ft`, `idx_fileversion_ft`,
  `idx_orgkeyword_ft`).

- Concept-graph CRUD (ConceptGraphStrategy) — `upsertConcept`,
  `attachFileToConcept` (dispatches HAS_CONCEPT / PLAYS_ROLE /
  BELONGS_TO_DOMAIN), `upsertTestsEdge` (file-to-file `:TESTS`),
  `upsertContract` + `attachFileToContract` (DEFINES / CONSUMES),
  `upsertGuidepost` + `attachGuidepost` (polymorphic `:ABOUT` to file /
  concept / contract). All canonical-keyed on `(orgId, knowledgeId, slug)`;
  every node and edge carries `enrichmentRunId` for traceability.
  Concept-graph schema is bootstrapped by `ensureConceptGraphIndexes()`.

The package does **not** own:

- Document-DB reads — those go through `@bb/db`
- Telemetry — driver defaults apply.
- Migration tooling — the `IF NOT EXISTS` constraint creates handle
  schema drift; richer migrations land later

## Public exports

```ts
function connectNeo4j(): Promise<void>;
function closeNeo4j(): Promise<void>;
function pingNeo4j(): Promise<PingResult>;
function ensureKnowledgeIndexes(): Promise<void>;

function upsertKnowledgeNode(doc: KnowledgeDoc): Promise<void>;
function setKnowledgeStateInGraph(knowledgeId: string, state: KnowledgeState): Promise<void>;
function deleteKnowledgeGraph(knowledgeId: string): Promise<void>;
function upsertFileNode(input: UpsertFileNodeInput): Promise<void>;
function upsertFileNodesBatch(inputs: readonly UpsertFileNodeInput[]): Promise<void>;
function upsertFolderNode(input: UpsertFolderNodeInput): Promise<void>;
function upsertFolderNodesBatch(inputs: readonly UpsertFolderNodeInput[]): Promise<void>;

function runCypher<T = unknown>(query: string, params?: Record<string, unknown>): Promise<T[]>;

interface PingResult {
  ok: boolean;
  latencyMs: number;
}
interface UpsertFileNodeInput {
  knowledgeId;
  relativePath;
  language;
  sha;
  sizeBytes;
  analysis: FileAnalysis;
}
```

`_getDriver` and `__resetForTests` are **internal** — consumed only
inside the package. Higher tiers cannot reach a raw `Driver` handle.

`runCypher` is the **only** public read primitive — re-exported from
`_runCypher` so domain-tier consumers (`@bb/mcp` retrieval) can run
arbitrary read queries without each one being typed at the infra
layer. Writes still go through the dedicated `upsert*` helpers; the
`@bb/neo4j` package intentionally does not expose a raw `Driver` or
session.

## Graph schema (v1)

```
(:Knowledge {knowledgeId, sourceKind, sourceUrl, branch, repoName, state, createdAt, updatedAt})
  -[:HAS_FILE]->
(:File {knowledgeId, relativePath, language, sha, sizeBytes, purpose, summary, businessContext, updatedAt})
  -[:HAS_KEYWORD]->  (:Keyword  {name})         // global, lowercase, MERGE-deduped
  -[:HAS_CLASS]->    (:Class    {signature})    // global, MERGE-deduped
  -[:HAS_FUNCTION]-> (:Function {signature})    // global, MERGE-deduped
  -[:HAS_IMPORT_INTERNAL]-> (:Module {name})    // relative imports (./ or ../)
  -[:HAS_IMPORT_EXTERNAL]-> (:Module {name})    // external packages / stdlib
```

`Knowledge.repoName` is derived once at upsert time from the source —
`owner/repo` (with `.git` stripped) for github sources, basename of the
absolute path for local sources. It is a display label only; identity
remains `knowledgeId`.

Constraints (uniqueness, idempotent via `IF NOT EXISTS`):

- `Knowledge(knowledgeId)`
- `File(knowledgeId, relativePath)`
- `Keyword(name)`, `Class(signature)`, `Function(signature)`, `Module(name)`

Fulltext indexes (idempotent via `IF NOT EXISTS`, consumed by `@bb/mcp`
search/lookup tools — never read inside this package):

- `idx_file_purpose_summary_ft` — `(File.purpose, File.summary)`
- `idx_file_business_context_ft` — `(File.businessContext)`
- `idx_keyword_name_ft` — `(Keyword.name)`
- `idx_symbol_signature_ft` — `(Class|Function).signature`

### Concept-graph schema (ConceptGraphStrategy)

Created by `ensureConceptGraphIndexes()`. Independent of the flat-folder
schema — strategies can coexist on the same database.

```
(:File) -[:HAS_CONCEPT]->        (:Concept   {orgId, knowledgeId, slug, kind, name, rationale, enrichmentRunId, createdAt, updatedAt})
(:File) -[:PLAYS_ROLE]->         (:Concept   {…})
(:File) -[:BELONGS_TO_DOMAIN]->  (:Concept   {…})
(:File) -[:TESTS]->              (:File)
(:File) -[:DEFINES]->            (:Contract  {orgId, knowledgeId, slug, kind, name, enrichmentRunId, …})
(:File) -[:CONSUMES]->           (:Contract  {…})
(:Guidepost {orgId, knowledgeId, slug, kind, note, area, enrichmentRunId, …})
        -[:ABOUT]-> (:File | :Concept | :Contract)
```

Constraints (uniqueness, `IF NOT EXISTS`):

- `Concept(orgId, knowledgeId, slug)`
- `Contract(orgId, knowledgeId, slug)`
- `Guidepost(orgId, knowledgeId, slug)`

Fulltext indexes:

- `idx_concept_name_rationale_ft` — `(Concept.name, Concept.rationale)`
- `idx_contract_name_ft` — `(Contract.name)`
- `idx_guidepost_note_area_ft` — `(Guidepost.note, Guidepost.area)`

Merge policy: `kind` + `rationale` (concepts only) + `createdAt` are
first-write-wins (set `ON CREATE` only); `name`, `enrichmentRunId`, and
`updatedAt` are last-write-wins (set `ON MATCH`). Multiple per-file
enrichment writes converge on the same canonical node without
clobbering original rationale.

Entity nodes are global (shared across all knowledge entries) so
cross-repo retrieval — "which files mention `auth` keyword across all
indexed repos" — is a single Cypher hop. Class / Function nodes use the
full analysis signature string (`"createApplication (~L32-150): factory entry"`)
as the identity property; semantic dedup of name-only collisions is a
future concern.

## Data ownership

The single shared `Driver` instance and all `:Knowledge / :File /
:Keyword / :Class / :Function / :Module` nodes + the four relationships
listed above. Nothing else in the graph is owned by this package; users
or other tools sharing the same Neo4j db are responsible for their own
labels.

## Invariants

1. **No env reads.** All config via `@bb/config` (`Neo4jUri / Neo4jUser /
Neo4jPassword`). Repo-wide ESLint rule blocks `process.env`.
2. **`connectNeo4j()` is idempotent and concurrent-safe.** Repeated
   calls return the existing driver; concurrent calls await the same
   in-flight connect promise.
3. **`closeNeo4j()` is graceful.** Clears the cached driver before
   awaiting `driver.close()` so a subsequent `connectNeo4j()` cleanly
   re-establishes.
4. **Errors are typed, not strings.** `Neo4jConfigError` carries the
   exact `plumbline set …` hint; `Neo4jConnectError` redacts userinfo
   in the URI; `Neo4jNotConnectedError` is a marker.
5. **Schema bootstrap is tolerant.** `ensureKnowledgeIndexes()` swallows
   "already exists" errors (Neo4j refuses constraints when a matching
   plain index exists). Operators must drop conflicting indexes manually
   if uniqueness guarantees matter.
6. **`upsertFileNode` and `upsertFileNodesBatch` clear stale relationships
   before re-attaching.** Re-runs of the same `(knowledgeId, relativePath)`
   produce a clean relationship set rather than accumulating outdated
   keywords/imports. In the batched variant the clear-then-attach happens
   atomically inside one transaction per batch — partial failures roll
   back, so re-runs always start from a consistent state.
7. **No raw `Driver` leaks.** `_getDriver()` is not in `src/index.ts`.
   Higher tiers go through the typed helpers.

## External dependencies

- `neo4j-driver@^6` — official driver
- `@bb/config`, `@bb/types`, `@bb/errors` — workspace deps

## What is intentionally out of scope (v0)

- Read queries (defer to `@bb/graph`)
- Schema migrations / drops / renames (only `IF NOT EXISTS` creates)
- Multi-database support (we use the default `neo4j` db)
- Pub/sub / change-data-capture
- Pruning of orphan `:Keyword / :Class / :Function / :Module` nodes
  when files are deleted (future cleanup pass — `deleteKnowledgeGraph`
  detaches edges but leaves the global entity nodes for cross-repo dedupe)

## How to extend

Adding a new node label or relationship:

1. Add the constraint to `CONSTRAINTS` in `src/indexes.ts`.
2. Add a typed helper to `src/<area>.ts` (or extend an existing file).
3. Re-export from `src/index.ts`.
4. Update the _Graph schema_ + _Public exports_ sections of this file.

Splitting into `@bb/neo4j` + `@bb/graph` (when `@bb/mcp` retrieval lands):

1. Move `indexes.ts`, `knowledge.ts`, `files.ts` into a new
   `packages/graph/` package.
2. `@bb/neo4j` keeps `client.ts` only and exposes `_runCypher` as a
   public export for `@bb/graph` to consume.
3. Update workspace deps for `@bb/ingest-github` and `@bb/server`.
