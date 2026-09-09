# Changelog

All notable changes to Plumbline are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The document store is now SQLite.** MongoDB is removed: the `mongo` container is
  gone from `infra/docker/docker-compose.yml`, and `~/.plumbline/data.sqlite` holds the
  knowledge documents, raw file rows, activity, usage, and the concept-graph enrichment
  ledger.
- Existing installs upgrade in place: a `config.json` carrying `db_provider: "mongo"` is
  migrated to `sqlite` on read, and the retired `mongo_uri` key is dropped from the file
  on the next config write. **Data is not migrated** — repositories indexed against
  MongoDB must be re-indexed.
- **The job queue is now SQLite too.** Redis and BullMQ are removed: the job queue is
  Honker over SQLite (`~/.plumbline/queue.db`) in every configuration, so the `redis`
  container is gone from `infra/docker/docker-compose.yml`. A stored
  `queue_provider: "bullmq"` migrates to `honker` on read, and the retired `redis_url`
  key is dropped from `config.json`. **In-flight jobs are not migrated** — drain or
  re-submit anything queued before the upgrade.
- Neo4j is now the only container `plumbline boot` starts.
- `DELETE /api/v1/repos/<knowledgeId>` renames its `mongoDeleted` response field to
  `dbDeleted`.

### Removed

- The `@bb/mongo` package, the `mongo_uri` config key, and the `mongo` value of
  `db_provider`.
- The `@bb/redis` and `@bb/queue-bullmq` packages, the `redis_url` config key, the
  `bullmq` value of `queue_provider`, and the `Redis*` error classes.

## [0.1.0] — 2026-05-08

### Added

- Initial public release.
- `plumbline-server` HTTP daemon (Express 5) with ingestion routes (`/api/v1/...`) and MCP transport (`/mcp`, HTTP + SSE).
- `plumbline` CLI (Ink/React TUI + commander) with subcommands: `boot`, `index`, `ingest`, `pull`, `ls`, `delete`, `set`, `server`, `shutdown`, `stats`, `mcp`.
- GitHub repository ingestion via `BasicFileAnalysisStrategy` (file-walk + per-file LLM analysis).
- MCP retrieval tools: `smart_search`, `keyword_lookup`, `retrieve_file` .
- Token-usage telemetry persisted to MongoDB (`mcp_activity`, `usage_summary`); live USD estimate against OpenRouter pricing via `plumbline stats`.
- Local-first single-tenant architecture (`orgId="local"`); BYO MongoDB + Neo4j + Redis.
- Configuration via `~/.plumbline/config.json` (no `.env`), managed through `plumbline set <key> <value>`.
- BullMQ in-process workers with retryable, idempotent jobs.
- Winston structured logging to `~/.plumbline/logs/` plus stdout.

### License

- AGPL-3.0-only with an additional non-commercial clause. See [LICENSE](LICENSE).
