# `@bb/ingest-github/src/payload`

Defensive payload narrowing for the queue job entry. The public repo's queue
payloads come from `@bb/types` so they are already typed, but the handler
re-validates because:

1. Job documents are persisted between enqueue and execute. A schema
   change between server restarts could leave stale payloads at the head of
   the queue; narrowing produces a structured `IngestError` instead of a
   `TypeError` from accessing `undefined`.
2. Local `plumbline ingest <dir>` paths can construct payloads outside the
   normal `enqueueGithubIndex` factory.

## Files

- `narrow.ts` — `narrowGithubIngest`, `narrowLocalIngest`, `isEnvelopeCoherent`.
- `README.md` — this file.

## Invariants

- Narrow functions return the canonical typed shape, not the raw `Record`.
- Failed validation throws `IngestError(knowledgeId, reason)` so the queue
  worker promotes it into a terminal `JobResult.FAILED` via the existing
  error path.
- Optional fields are passed through only when present and non-empty. In
  particular, `orgId` is preserved when the payload carries it (downstream
  consumers may set it per-job); when absent, the pipeline falls back
  to `Config.OrgId` from `~/.plumbline/config.json` (locked to `"local"` in
  OSS — see `@bb/config/src/README.md`).
