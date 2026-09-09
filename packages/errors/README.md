# `@bb/errors` — context

## Tier

Kernel. Sits at the bottom of the import graph alongside `@bb/types`. May
depend on `@bb/types` (for type-only references like the `Config` enum). May
be imported by every higher tier.

## Responsibility

Single catalog of every typed error class thrown across the workspace.
Centralizing them gives the logger a stable discriminator (`error.name`)
so structured logs can identify failure modes without each package
re-introducing its own error namespace.

Today the catalog covers:

- **Config** — `ConfigIncompleteError` (missing required keys; carries the
  missing `Config[]` and the corresponding `plumbline set …` hints)
- **Knowledge** — `KnowledgeNotFoundError` (a repository operation such as
  `setKnowledgeState` matched no document; carries the offending
  `knowledgeId` as a typed field). Provider-agnostic — every
  `IDocumentDatabaseProvider` implementation throws it. Lives in
  `knowledge-errors.ts`.
- **Queue** — `QueueConnectError` (queue provider construction failed;
  carries `cause`), `QueueNotConnectedError` (publisher or
  `registerWorker` called before `connectQueue()`).
- **LLM** — `LlmConfigError` (missing OpenRouter API key; carries the
  `plumbline keys set` hint), `LlmError` (HTTP non-2xx, timeout, empty
  completion; carries `cause`).
- **Ingest** — `GitCloneError` (git binary failed; redacts userinfo in
  the repo URL), `IngestError` (catch-all worker failure; carries
  `knowledgeId` and `cause`), `RepoUnavailableError` (source repo gone or
  inaccessible — terminal; the failure classifier maps it to the
  `repo_unavailable` category → knowledge marked `CORRUPTED`),
  `IngestPathError` (`plumbline ingest <path>`
  pre-flight failure: missing path / not a directory),
  `UsageLimitExceededError` (thrown by a runtime `UsageGuard`
  implementation when a token quota would be exceeded mid-run; carries
  `knowledgeId`, `phase`, `current`, `max`, and the cumulative
  `UsageLimitExceededDetail`). OSS standalone never throws this; the
  pipeline only catches it when an optional guard is wired in.
- **Server** — `ServerConfigError` (missing required config at boot;
  carries `missing[]` + matching `plumbline set …` hints),
  `ServerStartTimeoutError` (spawned server never passed its health check;
  carries `logPath`), `ServerInfraDownError` (server's `/health` reports an
  infra dependency down; carries the `services[]` names),
  `ServerInfraUnreachableError` (a configured infra URI is not TCP-reachable
  before the server is spawned; carries `services[]` of `{name, uri}`),
  `ServerProcessExitedError` (spawned server process exited immediately;
  carries the captured `logTail`). The last four are thrown by the CLI's
  server-spawn / lifecycle path.
- **Neo4j** — `Neo4jConfigError` (missing URI / user / password),
  `Neo4jConnectError` (driver `verifyConnectivity()` failed; redacts
  userinfo in URI), `Neo4jNotConnectedError` (`_getDriver()` called
  before `connectNeo4j()`).
- **Layout** — `LayoutMigrationRequiredError` (the legacy on-disk layout
  `repos/.meta/<knowledgeId>/` is present; the server refuses to boot
  until the operator runs `plumbline migrate paths`). Carries the
  detected legacy path in the message and the migration hint as a typed
  `hint` field.

New error classes land here as new packages are introduced.

## Public exports

```ts
class ConfigIncompleteError    extends Error
class KnowledgeNotFoundError   extends Error
class QueueConnectError        extends Error
class QueueNotConnectedError   extends Error
class LlmConfigError           extends Error
class LlmError                 extends Error
class GitCloneError            extends Error
class IngestError              extends Error
class IngestPathError          extends Error
class UsageLimitExceededError  extends Error
class ServerConfigError        extends Error
class ServerStartTimeoutError  extends Error
class ServerInfraDownError     extends Error
class ServerInfraUnreachableError extends Error
class ServerProcessExitedError extends Error
class Neo4jConfigError         extends Error
class Neo4jConnectError        extends Error
class Neo4jNotConnectedError   extends Error
class LayoutMigrationRequiredError extends Error
```

## Data ownership

None. Pure class declarations.

## Invariants

1. **No I/O, no logging.** This package never imports `@bb/logger` —
   `@bb/logger` imports _from_ this one.
2. **Stable `name`.** Every class sets `override readonly name` to its class
   name. The logger keys off this string; renaming is a coordinated change.
3. **Credential redaction.** Any error message that includes a connection
   URI must redact userinfo (see `redactUri` in `neo4j-errors.ts`).
4. **Typed metadata over string parsing.** Errors carry structured fields
   (`hint`, `missing`, `hints`, `cause`) — consumers read those, never parse
   `message`.

## External dependencies

- `@bb/types` — type-only, for the `Config` enum referenced by
  `ConfigIncompleteError`

No runtime dependencies, no Node built-ins.

## What is intentionally out of scope

- Logger formatters / stack-trace pretty-printing — `@bb/logger`'s job.
- Error → HTTP status mapping — the route layer's job.
- Retry / backoff policy — the calling package's job.

## How to extend

To add a new error class:

1. Create or extend `src/<area>-errors.ts` (one file per source package).
2. `extends Error`, `override readonly name = "<ClassName>"`, expose typed
   fields rather than string-encoding context.
3. Re-export from `src/index.ts`.
4. The throwing package adds `@bb/errors` to its `dependencies` (if not
   already) and imports the class.
5. Update the _Public exports_ section of this file.
