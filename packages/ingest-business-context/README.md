# `@bb/ingest-business-context` — context

## Tier

Domain. Depends on Kernel (`@bb/types`, `@bb/errors`), Infrastructure (`@bb/config`, `@bb/neo4j`),
Cross-cutting (`@bb/llm`), and Strategy (`@bb/queue`). One horizontal Domain→Domain dependency on
`@bb/ingest-github` (read-only path helpers + the on-disk layout it owns). May be imported by
Binaries (`@bb/server` calls `registerBusinessContextWorker()` once at boot). Never by `@bb/cli`.

## Responsibility

Attaches human-authored business-context notes to a specific indexed commit of a GitHub knowledge.
The package consumes `JobType.BusinessContextProcessing` jobs. For each job it:

1. Validates the commit is indexed (Neo4j contains either `:File {knowledgeId}` or
   `:FileVersion {knowledgeId, commitHash}`).
2. Reads optional enrichment from disk (`metaRoot/repo-summary.json`, `metaRoot/org/<orgId>/*.json`).
3. Runs one LLM call to generate a concise title, then three parallel LLM calls covering
   product fields, technical fields, and the shared overview.
4. Persists the result to disk at
   `metaRoot/commits/<commitHash>/business-context/<sanitizedTitle>/{original.txt,analysis.json}`.
5. Projects the analysis into Neo4j as a `:BusinessContext` node plus a `:BusinessContextVersion`
   snapshot keyed by `(knowledgeId, commitHash)`. The version node `:DESCRIBES` every
   `:FileVersion {knowledgeId, commitHash}` that exists for the same commit; if none exist yet
   (BC authored before the commit was snapshot), zero edges are created and a later run will
   backfill them via the same idempotent MERGE.
6. Creates `:OrgKeyword` nodes for each array field (10 typed relationship classes such as
   `HAS_DOMAIN_KEYWORD`, `HAS_STAKEHOLDER`, `HAS_AFFECTED_MODULE`) connected to the parent
   `:BusinessContext` via `:APPEARS_IN_BUSINESS_CONTEXT`.

## Public exports

- `registerBusinessContextWorker(deps?)` — boots the worker. Called by the deployable at startup.
- `executeBusinessContextStrategy(input)` — the disk pipeline (validate → enrichment → title →
  analysis → save). Returns the resolved storage paths and the title. Safe to call directly from
  HTTP for synchronous flows.
- `storeBusinessContextToNeo4j(input, analysis, sanitizedTitle)` — graph persistence. Separated
  so callers can run it inline or defer it.
- `BUSINESS_CONTEXT_FIELD_DEFS` — single source of truth for the 16-field LLM analysis schema.
- Types: `BusinessContextInput`, `BusinessContextAnalysis`, `BusinessContextStorageResult`,
  `BusinessContextNeo4jResult`, `BusinessContextAnalysisMetadata`, `CommitNotIndexedError`.

## Invariants

- Single LLM call surface — never bypass `@bb/llm`. Outputs are validated against the field-defs
  schema before persistence.
- `:BusinessContext` and `:BusinessContextVersion` are addressed by `(knowledgeId, nodeId)` /
  `(knowledgeId, nodeId, commitHash)`; all MERGEs are idempotent and re-runnable.
- `nodeId` is the sanitized title (kebab-case, ≤80 chars). Two BC submissions that LLM-title to the
  same string will MERGE onto the same node — by design.
- No outbound calls. No GitHub-API lookups. The strategy never clones or pulls — it operates on
  the meta-output already produced by `@bb/ingest-github` for the indexed commit.
- All disk writes scoped under
  `<orgs>/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commitHash>/meta-output/business-context/`
  via the `@bb/ingest-github` path helpers (`businessContextDir(knowledgeId,
commitHash, slug)`) — this package never invents its own layout. The
  helper is **async**: it reads `KnowledgeDoc` from the document store to derive
  `(orgId, owner, repo)` from `info.repoUrl`, then resolves the
  commit-scoped path. Every call site awaits.
