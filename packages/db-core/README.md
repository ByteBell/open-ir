# `@bb/db-core`

Provider-agnostic interfaces for the document database layer.

## Responsibilities

Defines the contract that every document database backend must implement. `@bb/sqlite` is the only implementation shipped today. Contains no I/O — pure TypeScript interfaces and shared types.

## Public Interfaces

- `IDocumentDatabaseProvider` — composite of all repository interfaces plus `connect`/`close`/`ping`
- `IKnowledgeRepository` — CRUD for knowledge entries. Failure lifecycle: `markKnowledgeFailed` (terminal), `markKnowledgeHalted` (transient, auto-retry pending — same `failure` subdoc), `markKnowledgeCorrupted` (terminal CORRUPTED — source repo gone/inaccessible, `repo_unavailable` category; index stays queryable but the auto-pull sweep drops it), and `promoteHaltedToFailed` (HALTED → FAILED, scoped to current HALTED so it is idempotent; called by the queue finalizer on retry exhaustion).
- `IRawRepository` — upsert, list SHA map, delete raw file docs
- `IAggregateStatsRepository` — `aggregateStats()`
- `IActivityRepository` — `recordActivity()`
- `IUsageRepository` — `incrementUsage`, `getMonthlyUsage`, `getGlobalUsage`
- `IEnrichmentRepository` — per-file enrichment ledger for the concept-graph strategy: `startEnrichmentRun`, `getCompletedEnrichmentFiles`, `markFileEnriched`, `recordEnrichmentFailure`, `completeEnrichmentRun`, `failEnrichmentRun`. State lives on the knowledge document; it is the resume cursor a queue retry reads so finished files are skipped.
- `DbPingResult` — health probe result shape
- `FileAnalysis`, `RawFileDoc` — shared raw-file types

## Data Ownership

None. This package owns no data — it only describes shapes.

## Tier

Strategy (interfaces consumed by `@bb/db` and implemented by `@bb/sqlite`)
