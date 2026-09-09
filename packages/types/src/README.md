# `@bb/types/src` — context

Implementation of `@bb/types`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

## Files

- **[index.ts](index.ts)** — public re-exports. The only entry point other
  packages may import. Anything not re-exported here is internal.
- **[config.ts](config.ts)** — the `Config` enum: every key under
  `~/.plumbline/config.json`. The string values match the on-disk JSON keys
  (`server_port`, `sqlite_path`, …). Lives here — not in `@bb/config` — so that
  consumers like `@bb/logger` and `@bb/sqlite` can refer to a config key
  without taking a dependency on `@bb/config`'s schema/loader/writer
  implementation.
- **[job.ts](job.ts)** — the queue vocabulary: `JobType` (today: GitHub
  index + pull, local ingest), `JobPriority`, the per-type payload
  interfaces (`GithubIndexPayload`, `GithubPullPayload`,
  `LocalIngestPayload`), the `PayloadLlmOverrides` mixin, the
  `JobMessage<P>` envelope wrapping payloads as the queue's job data, and
  the `PayloadFor<T>` type-level dispatcher. Shared between `@bb/queue`
  (publisher) and `@bb/ingest-*` packages (worker handlers). Ingest
  payloads carry an optional `orgId?: string` override; OSS callers omit
  it and the pipeline reads `Config.OrgId` from `~/.plumbline/config.json`
  (locked to `"local"` in OSS builds; downstream consumers may set
  `orgId` per-job). Both GitHub payloads also extend `PayloadLlmOverrides`
  which adds optional `llmApiKey?`, `llmProvider?: string`, `llmModel?`,
  `llmKeyId?` — the extension point that lets downstream consumers
  resolve per-org LLM credentials at the enqueue boundary and pass them
  through the payload. `llmProvider` is `string` (not a closed
  union) so multi-provider consumers can carry `"anthropic"`,
  `"gemini"`, etc.; OSS narrows to `"openrouter"`/`"ollama"` at the LLM
  client boundary. `llmKeyId` is opaque audit metadata OSS ignores. OSS
  standalone leaves all four fields unset and the pipeline falls back to
  `Config.OpenrouterApiKey` + `Config.LlmProvider`. `GithubPullPayload`
  also carries an optional `orgId?` so downstream multi-tenant workers
  can scope document-store/Neo4j lookups by org.
- **[knowledge.ts](knowledge.ts)** — the `KnowledgeState` enum modeling
  the lifecycle in [CLAUDE.md](../../../CLAUDE.md), plus the
  `KnowledgeDoc` document interface and its substructures:
  - `KnowledgeSource` is a discriminated union (`GithubKnowledgeSource | LocalKnowledgeSource`)
    that captures **what kind of upstream produced this knowledge** plus per-kind
    state. For github: `commitId` (current head) and `commitHashes` (history).
    For local: `sourcePath`. `source` does **not** carry `repoUrl` or `branch` —
    those live on `info` (see below).
  - `KnowledgeInfo` carries the human-readable repo coordinates the pipeline
    needs every run: `repoUrl`, `branch`, plus an open index signature so
    downstream consumers can stash extra fields without forcing schema changes
    here. The pull pipeline reads `knowledge.info.repoUrl` / `knowledge.info.branch`
    directly — that's the single source of truth for the URL/branch, no fallback.
  - `KnowledgeFailureCategory` is a closed union covering the operator-facing
    failure taxonomy: `"llm_config"` (no key), `"llm_auth"` (401/403),
    `"llm_quota"` (402), `"llm_rate_limit"` (429), `"llm_unreachable"`
    (5xx / network / timeout), `"cancelled"`, `"internal"`. The
    HTTP-status → category mapping lives in
    `@bb/ingest-github/src/pipeline/failure-classifier.ts`.
  - `KnowledgeFailure` is the structured failure record:
    `{ reason: string; category: KnowledgeFailureCategory; at: Date; detail?: string }`.
    `reason` is a single short operator-readable sentence (UI surfaces it
    directly), `detail` is the raw provider response body (UI hides it
    behind a disclosure).
  - `KnowledgeDoc` carries both: `source` for upstream-type + indexed-commit
    state, `info` for repo coordinates. Both are required on every doc. The
    optional `failure?: KnowledgeFailure` field is populated when
    `status.state === FAILED` and cleared automatically by the next
    `setKnowledgeState` call (the function `$unset`s it on transitions out
    of FAILED).
  - `EnrichmentState` (`Pending | Running | Completed | Failed`) and
    `EnrichmentFailure` (`{ filePath, reason, attemptCount, lastError,
lastAttemptAt }`) plus `EnrichmentFailureReason` (`"cap-exceeded" |
"validation-failed" | "provider-error"`) live here too. Optional
    `enrichmentRunId`, `enrichmentState`, `completedFiles[]`,
    `enrichmentFailures[]` fields hang off `KnowledgeDoc` for the
    ConceptGraphStrategy ledger; absent on legacy flat-folder
    knowledges.
- **[graph.ts](graph.ts)** — kernel graph types: `NodeScope`,
  per-summary payloads, `Upsert*Input` shapes. Also home of the
  ConceptGraphStrategy schema kernel: `ConceptKind`, `ContractKind`,
  `GuidepostKind` enums; `ConceptEdgeKind` / `ContractEdgeKind`
  discriminators; `UpsertConceptInput`, `AttachFileToConceptInput`,
  `UpsertContractInput`, `AttachFileToContractInput`,
  `UpsertGuidepostInput`, `AttachGuidepostInput`, `UpsertTestsEdgeInput`.
  Consumed by `@bb/graph-core` (interfaces) and `@bb/neo4j`
  (implementation).
- **[path-layout.ts](path-layout.ts)** — pure on-disk path resolver.
  Defines the `RepoLocation` union (github / local) and pure functions
  (`plumblinePathsFor`, `commitBaseDirFor`, `repositoryDirFor`,
  `metaOutputRootFor`, `orgsRootFor`) that take a `home` string and
  return the kube-style layout
  `<home>/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/`.
  Also exports `parseGithubOwnerRepo(repoUrl)` — a pure URL parser that
  mirrors the `parseGithubRepo` in `@bb/ingest-github/githubUrl`
  (duplicated deliberately so kernel-tier code never reaches up into
  Domain). Both implementations accept `github.com` AND `gitlab.com`
  hostnames so the path resolver can build a `RepoLocation` for GitLab
  knowledges routed through the GitHub pipeline via an injected
  `SourceFactory`; the union still only has a `github` provider variant,
  so gitlab projects share the github path segment on disk. For
  subgroup-aware gitlab URLs (`group/sub/project`) use the companion
  `parseGitlabOwnerRepo(repoUrl)`, which collapses every segment except
  the last into the `owner` namespace (`owner="group/sub"`,
  `repo="project"`) — matching `deriveOwnerRepo` in the GitLab
  `SourceFactory`, so the ingest-write and business-context-read disk
  paths agree for nested projects. The `MetaPathsLayout` interface
  documents the leaf-path shape returned by `plumblinePathsFor`. Lives
  here so `@bb/ingest-github` (writer) and `@bb/mcp` (reader) can
  agree on the layout without one importing the other.

## Module dependency graph

```
config.ts      → (leaf — no imports)
job.ts         → (leaf — no imports)
knowledge.ts   → (leaf — no imports)
graph.ts       → ./analysis.ts (type-only)
path-layout.ts → node:path (kernel-permitted std lib only)
index.ts       → re-exports all of the above
```

Pure declarations, no cycles possible.

## Invariants enforced here

- **No imports.** Source files import nothing — not from this package, not
  from siblings, not from Node built-ins. If an entry needs to import, it
  belongs in a higher tier.
- **Enum string values are the on-disk JSON keys.** `Config.SqlitePath =
"sqlite_path"` is the contract `@bb/config`'s Zod schema relies on; renaming
  a value is a breaking change for both the file format and every consumer.
- **One file per logical group.** `config.ts` holds config keys, `job.ts`
  holds queue vocabulary, `knowledge.ts` holds knowledge-document
  vocabulary. Future domain shapes (`Raw`, `Node`, `MCP*`) get their own
  files when promoted from internal to shared. Don't pile unrelated types
  into a single file.

## Adding a shared type

Follow the recipe in [../README.md](../README.md) under _How to extend_.
A type is promoted to this folder only when **two or more** packages need
to refer to the same shape; single-package types stay where they are used.
