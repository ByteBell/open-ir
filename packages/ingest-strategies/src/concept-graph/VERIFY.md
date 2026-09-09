# ConceptGraphStrategy — manual end-to-end verification

The unit tests in `__tests__/enrichment.test.ts` cover the pure-logic surface
(schema validation, slug derivation). A full strategy run requires SQLite +
Neo4j + an OpenRouter key, so end-to-end verification is a
documented manual playbook rather than a CI test.

Run the playbook below after any change that touches Phase 4 (file store) or
Phase 5 (enrichment), or before promoting `concept-graph` from opt-in to
default.

## Prerequisites

- `plumbline-server` running locally with Neo4j reachable
- An OpenRouter API key configured (`plumbline keys set`)
- A tool-use-capable enrichment model selected (Anthropic Claude Sonnet 4.x
  / Opus 4.x via OpenRouter — confirmed to support OpenAI-style `tool_calls`)
- A small public repo to index (5–50 files is ideal)

## Step 1 — Configure the strategy

```bash
plumbline set ingestion.strategy concept-graph
plumbline set enrichment.model anthropic/claude-sonnet-4
# Defaults are sensible; override only if you have a reason:
# plumbline set enrichment.max.tool.calls.per.file 15
# plumbline set enrichment.max.iterations.per.file 8
# plumbline set enrichment.wall.time.ms.per.file 400000
# plumbline set enrichment.concurrency 16
```

Restart the server so the new config is picked up:

```bash
plumbline shutdown
plumbline boot
```

Check the server log for `ingest-github: active strategy = concept-graph`.

## Step 2 — Index a small repo

```bash
plumbline index https://github.com/some/small-repo
plumbline ls   # wait until state = PROCESSED
```

Phase progression in the log should be:

```
concept-graph: phase1 (scan + classify) ...
concept-graph: phase2 (analyse small N + big M) ...
concept-graph: phase3 (backfill missing fields) ...
concept-graph: phase4 (store files; no :Folder/:Repo) ...
concept-graph: phase5 (per-file MCP enrichment) ...
concept-graph: phase5 done — enriched=N runId=<uuid>
```

## Step 3 — Inspect Neo4j

Replace `<KID>` with the `knowledgeId` from `plumbline ls`.

```cypher
// Files are written; no :Folder, no :Repo for this knowledge.
MATCH (f:File {knowledgeId: $kid}) RETURN count(f);
MATCH (:Folder {knowledgeId: $kid}) RETURN count(*);   // must be 0
MATCH (:Repo {knowledgeId: $kid}) RETURN count(*);     // must be 0

// Concepts exist; sample by kind.
MATCH (c:Concept {knowledgeId: $kid})
RETURN c.kind, count(*) ORDER BY count(*) DESC;

// Files attached to a concept via the conceptual edges.
MATCH (f:File {knowledgeId: $kid})-[r:HAS_CONCEPT|PLAYS_ROLE|BELONGS_TO_DOMAIN]->(c:Concept)
RETURN type(r), c.kind, c.slug, count(f) ORDER BY count(f) DESC LIMIT 20;

// Contracts.
MATCH (f:File {knowledgeId: $kid})-[r:DEFINES|CONSUMES]->(c:Contract)
RETURN type(r), c.kind, c.slug, count(f) ORDER BY count(f) DESC LIMIT 20;

// Guideposts.
MATCH (g:Guidepost {knowledgeId: $kid})
RETURN g.kind, g.slug, g.area, g.note LIMIT 20;

// Tests edge — only present when the repo has test files.
MATCH (t:File)-[:TESTS]->(s:File)
WHERE t.knowledgeId = $kid
RETURN t.relativePath, s.relativePath LIMIT 20;
```

Pass criteria:

- `:File` count matches `KnowledgeDoc.completedFiles` length
- `:Folder` and `:Repo` counts are both zero
- At least one `:Concept` exists with `kind` in (`role`, `pattern`, `domain`)
- Each `:Concept` / `:Contract` / `:Guidepost` carries an `enrichmentRunId`

## Step 4 — Inspect the document store

The knowledge document is stored as JSON in the `knowledge` table, so query
the enrichment ledger fields out of it:

```sh
sqlite3 ~/.plumbline/data.sqlite "
  SELECT json_extract(value, '\$.enrichmentRunId'),
         json_extract(value, '\$.enrichmentState'),
         json_array_length(json_extract(value, '\$.completedFiles')),
         json_extract(value, '\$.enrichmentFailures')
  FROM knowledge WHERE key = '<KID>';
"
```

Pass criteria:

- `enrichmentState === "completed"`
- `completedFiles.length` equals the scanned file count
- `enrichmentFailures` is empty (or absent)

## Step 5 — Test idempotency

Re-index the same repo:

```bash
plumbline index <repo-url> --force   # or trigger a pull-style re-run
```

Re-run Step 3's Cypher queries — node counts should be unchanged (concepts /
contracts / guideposts are MERGE-on-canonical-key, so repeated runs converge
without duplicate nodes).

## Step 6 — Test resume

Force a failure mid-enrichment:

1. Set `plumbline set enrichment.wall.time.ms.per.file 1` (1ms — every call
   will exceed wall-time)
2. Re-index the repo
3. Confirm:
   - `KnowledgeDoc.enrichmentState === "failed"`
   - `KnowledgeDoc.enrichmentFailures` contains per-file failure records
     with `reason: "cap-exceeded"`
   - Knowledge state is NOT `PROCESSED` (stays `PROCESSING` since
     enrichment threw)
4. Reset: `plumbline set enrichment.wall.time.ms.per.file 400000`
5. Re-index — `completedFiles` from the prior run is cleared on
   `startEnrichmentRun` and the run proceeds fresh

## Step 7 — Inspect disk artifacts

Under the commit-scoped layout (`plumbline migrate paths` if you're upgrading
from the legacy `repos/.meta/` tree first), every per-commit artifact lives
under `~/.plumbline/orgs/<orgId>/github/<KID>/<owner>/<repo>/<COMMIT_ID>/`. For
OSS the `<orgId>` segment is always `local`. The enrichment artifacts sit
beside the rest of meta-output:

```bash
ORG=local
ls ~/.plumbline/orgs/$ORG/github/<KID>/<OWNER>/<REPO>/<COMMIT_ID>/meta-output/enrichment/
```

Each successfully enriched file gets a JSON artifact named after its
flattened path. Open one to confirm the audit trail:

```bash
cat ~/.plumbline/orgs/$ORG/github/<KID>/<OWNER>/<REPO>/<COMMIT_ID>/meta-output/enrichment/src__auth__controller.ts.json
```

The artifact carries `enrichment` (the validated LLM output), `llmUsage`
(token + cost), `iterations`, `toolCallCount`, and `writtenAt`. Sibling dirs
under `meta-output/` (`file-analysis/`, `folder-summaries/`,
`big-file-analysis/`, …) hold the canonical analysis from phases 2–4. The
clone tree sits at `<COMMIT_ID>/repository/` — same parent as `meta-output/`.

## Step 8 — Smoke `smart_search` for concept clusters

From an MCP client (any tool that can speak streamable HTTP or SSE to
`http://localhost:8080/mcp`):

```json
{ "tool": "smart_search", "input": { "query": "authentication", "knowledgeIds": ["<KID>"] } }
```

Pass criteria:

- The response contains a non-empty `concept_clusters` array (when the
  search results include role/pattern/domain concept attachments)
- Each cluster lists `slug`, `kind`, `name`, `file_count`, `sample_files`

## Failure modes to flag

- **All files fail with `provider-error`** — likely the enrichment model
  doesn't support OpenRouter tool-use. Switch to a known-good Claude model.
- **All files fail with `validation-failed`** — the prompt and/or schema
  drifted. Inspect a captured artifact and the LLM's raw response in the
  server log.
- **All files fail with `cap-exceeded` at default limits** — investigate
  whether the LLM is looping on MCP tool calls without converging. Raise
  `Config.EnrichmentMaxIterationsPerFile` temporarily and re-run with a
  smaller repo to confirm the loop terminates.
