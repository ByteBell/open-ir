# `@bb/logger` — context

## Tier

Infrastructure. Depends on `@bb/config`, `winston`, and
`winston-daily-rotate-file`. May be imported by every higher tier (Strategy,
Domain, Binaries).

## Responsibility

Single logging surface for the workspace. Two sinks:

- **File** — daily-rotated `~/.plumbline/logs/<scope>-YYYY-MM-DD.log`, gzipped
  on rotation, retained for `log_retention_days`.
- **Console** — always on; verbosity from `log_level`. Colorized when stdout
  is a TTY.

## Public exports

```ts
type LoggerScope = "server" | "cli"
type LoggerFactory = (scope: LoggerScope) => Logger
type Logger                                          // re-exported from winston

const logger: Logger                                 // proxy → getLogger("server")
function getLogger(scope: LoggerScope): Logger
function seedLoggerFactory(factory: LoggerFactory): void
function shutdownLoggers(): Promise<void>
function getLogsDir(): string
function ensureLogsDir(): void

function __isLoggerFactorySeeded(): boolean
function __resetLoggersForTests(): void              // test-only
```

`logger` (the default export) is a Proxy that lazily resolves to
`getLogger("server")` on every access — necessary because the resolved logger
may change after `seedLoggerFactory` is called by a parent process.

`seedLoggerFactory(factory)` registers a factory used by all subsequent
`getLogger(scope)` calls. The previous scope cache is cleared on registration
so any logger already imported via the `logger` proxy resolves to the new
factory's output on its next method call. When no factory is seeded,
`getLogger` falls back to `buildLogger(scope)` — the disk-backed
DailyRotateFile + Console transport setup. The standalone binary never seeds
and gets the original behaviour bit-for-bit.

`getLogger(scope)` is idempotent. Workers tag via
`getLogger("server").child({ worker: "pdf-1" })` — there is no per-worker file
split.

## Sugar log API

`logger.info("message", obj)` auto-stringifies `obj` via `util.inspect` —
single-line for compact objects, multi-line for big ones. Circular refs are
handled gracefully.

## File layout

- `src/dirs.ts` — log dir resolution (under `getPlumblineHome()/logs`)
- `src/caller.ts` — stack-walk `file:line` helper
- `src/formats.ts` — sugar splat format + caller format + printf
- `src/transports.ts` — daily-rotate file + console transport factories
- `src/logger.ts` — `getLogger`, scope cache, shutdown
- `src/index.ts` — public re-exports

## Invariants

1. **No `process.env` reads.** All config flows through `@bb/config`.
2. **One file root per scope.** Scopes write to distinct rotated files.
3. **Console always on.** Local-first tool — the console is the UX. Verbosity
   via `log_level`.
4. **Idempotent `getLogger`.** Same scope → same `Logger` instance.
5. **`shutdownLoggers` drains.** Awaits each transport's `finish` / `close`
   event before resolving (with a 1-second hard cap so SIGTERM can't hang).

## Data ownership

- `~/.plumbline/logs/` directory creation (mode `0700`)
- `~/.plumbline/logs/<scope>-*.log` rotated files (mode `0600`)
- `~/.plumbline/logs/<scope>-*.log.gz` compressed rotated files

## What is intentionally out of scope

- Per-worker file split
- Manual startup-archive utility (rotation + retention replace it)
- JS↔TS path remapping (Bun runs TS directly)
- Custom log levels (winston defaults are kept)
