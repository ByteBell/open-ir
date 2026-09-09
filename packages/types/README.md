# `@bb/types` — context

## Tier

Kernel. Sits at the bottom of the import graph; depended on by every higher
tier (Infrastructure, Strategy, Domain, Binaries). Has no workspace
dependencies and no runtime dependencies — pure type / enum surface.

## Responsibility

Single home for shared types and enums that cross package boundaries:

- `Config` — the enumeration of every key under `~/.plumbline/config.json`.
  Lives here (not in `@bb/config`) because consumers in higher tiers — e.g.
  `@bb/logger`, `@bb/sqlite` — refer to it without wanting an implementation
  dependency on `@bb/config`'s schema/loader/writer.
- `JobType`, `JobPriority`, `JobMessage<P>`, `GithubIndexPayload`,
  `GithubPullPayload`, `LocalIngestPayload`, `PayloadFor<T>`,
  `PayloadLlmOverrides` — the queue/job vocabulary shared between
  `@bb/queue` (publisher) and `@bb/ingest-*` packages (worker handlers).
  `PayloadLlmOverrides` is the optional `{ llmApiKey?, llmProvider?,
llmModel?, llmKeyId? }` mixin that lets downstream consumers carry per-job
  LLM credentials through the payload — the extension point a downstream
  consumer uses to inject per-org credentials at the enqueue boundary.
  `llmProvider` is intentionally typed as `string` rather than
  a closed union — OSS standalone uses `"openrouter"`/`"ollama"`, but
  downstream consumers may carry richer taxonomies (`"anthropic"`,
  `"gemini"`, …) that OSS ignores at runtime. `llmKeyId` is opaque to OSS;
  it's an audit pointer kept by downstream consumers. Mixed into both
  GitHub payloads.
- `KnowledgeState` — the processing-status lifecycle enum (`CREATED →
QUEUED → INGESTED → PROCESSING → PROCESSED ↘ FAILED`, plus the terminal
  `CORRUPTED` for a source repo that is gone/inaccessible — indexed data stays
  queryable but the auto-pull sweep drops it) referenced by `@bb/queue` (writes
  `QUEUED`), `@bb/sqlite` (`setKnowledgeState`), and future ingest workers.
- `KnowledgeDoc`, `KnowledgeSource`, `GithubKnowledgeSource`,
  `LocalKnowledgeSource`, `KnowledgeInfo` — the cross-package shape of the
  `knowledge` document. Split into two substructures with
  non-overlapping responsibilities: `KnowledgeSource` discriminates the
  upstream type (github vs local) and carries per-kind ingestion state —
  for github, the current head commit and the full commit history; for
  local, the on-disk path. `KnowledgeInfo` carries the repo coordinates the
  pipeline reads on every run (URL and branch); it has an open shape so
  downstream consumers can attach extra fields without forcing schema
  changes here. The pull pipeline reads URL and branch off `KnowledgeInfo`
  directly — there is no fallback chain to `KnowledgeSource`. The
  ConceptGraphStrategy enrichment ledger lives on `KnowledgeDoc` too —
  optional `enrichmentRunId`, `enrichmentState` (`EnrichmentState` enum:
  `pending | running | completed | failed`), `completedFiles[]`,
  `enrichmentFailures[]` (carrying `EnrichmentFailureReason` =
  `cap-exceeded | validation-failed | provider-error`).
- Concept-graph kernel types (`ConceptKind`, `ContractKind`,
  `GuidepostKind` enums; `UpsertConceptInput`, `AttachFileToConceptInput`,
  `UpsertContractInput`, `AttachFileToContractInput`,
  `UpsertGuidepostInput`, `AttachGuidepostInput`, `UpsertTestsEdgeInput`
  and the `ConceptEdgeKind` / `ContractEdgeKind` discriminators). Live
  in `src/graph.ts`; consumed by `@bb/graph-core` (interfaces) and
  `@bb/neo4j` (implementation).
- `IngestionStrategyType` enum (`flat-folder | concept-graph`) — the
  closed set of values for `Config.IngestionStrategy`. Lives in
  `src/config.ts` alongside the other strategy-selection enums.
- `KnowledgeFailureCategory` — closed union of structured failure
  categories stamped on `KnowledgeDoc.failure` when a run ends in `FAILED`.
  Drives operator triage and UI hints. Categories:
  `llm_config | llm_auth | llm_quota | llm_rate_limit | llm_unreachable |
cancelled | usage_limit_exceeded | repo_unavailable | internal`.
  `repo_unavailable` is terminal — the source repo is gone/inaccessible; it
  drives the `CORRUPTED` state. `usage_limit_exceeded`
  exists for downstream consumers that enforce a token quota outside the
  LLM provider's own billing — OSS standalone never produces it.
- `TokenUsage` — `{ inputTokens, outputTokens, costUsd }`. Mirrors the
  per-phase token aggregate produced inside the strategy and re-used by
  `UsageGuard` so a guard implementation can compare or persist cumulative
  totals without further reshaping.
- `UsageGuard` — optional interface for runtime token-quota enforcement.
  Two async methods: `onPhaseComplete(phase, cumulative)` is invoked by
  the pipeline after every token-consuming phase; an implementation may
  throw to abort the run. `flushPartial(cumulative)` is invoked from the
  pipeline's catch path with the cumulative usage at the abort point so
  the partial spend can be recorded before the failure surfaces. OSS
  standalone leaves this `undefined` and behavior is unchanged.

Future inhabitants (added on need basis): full `Raw`, `Node`, `MCP*`
document shapes — the cross-package domain types named in
[docs/arch.md:69](../../docs/arch.md#L69).

## Data ownership

None. This package owns no runtime state — only types and enum members.

## Invariants

1. **No runtime dependencies.** `dependencies` block stays empty.
2. **No I/O, no logic.** Pure declarations. If logic creeps in, it belongs
   in a higher tier package.
3. **Stable surface.** Renaming an exported member is a breaking change for
   the entire workspace; treat additions as additive and removals as
   coordinated migrations.

## External dependencies

None.

## What is intentionally out of scope

- Runtime helpers (validators, parsers, narrowing functions) — those belong
  in the package that owns the data.
- Default values, hint strings, schema parsing — those stay in `@bb/config`.

## How to extend

To promote a type from a single-package internal to a shared kernel type:

1. Confirm at least two packages need to import it.
2. Move the declaration into `src/<name>.ts`.
3. Re-export from `src/index.ts`.
4. Add `@bb/types` to the importing package's `package.json` dependencies.
5. Update the source-of-record package to import from `@bb/types` rather
   than re-defining locally.
