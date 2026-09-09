# `@bb/logger/src` — context

Implementation of `@bb/logger`. See [../README.md](../README.md) for the
package-level contract.

## Files

- **[index.ts](index.ts)** — public re-exports.
- **[dirs.ts](dirs.ts)** — `getLogsDir`, `ensureLogsDir`. Wraps
  `@bb/config.getPlumblineHome()` with a `logs/` suffix; creates the dir at
  mode `0700`.
- **[caller.ts](caller.ts)** — `getCallerInfo()` and `toProjectRelative()`.
  Walks `Error.captureStackTrace` to find the first frame outside winston,
  Node internals, and this package. Caches the project root (nearest
  `package.json` with `workspaces`).
- **[formats.ts](formats.ts)** — three winston formats:
  - `sugarFormat` — appends `util.inspect(extra)` for each rest arg passed to
    `logger.info(msg, ...extras)`.
  - `callerFormat` — attaches `logpath`, `file`, `line`, `function` fields.
  - `buildPrintf` — final layout `${ts} [${logpath}]${meta} ${LEVEL}: ${msg}`.
- **[transports.ts](transports.ts)** — `makeFileTransport(scope)` returning
  a `winston-daily-rotate-file` configured with gzip + retention from
  `log_retention_days`; `makeConsoleTransport()` with TTY-aware colorize;
  `flushTransport(t)` waits for `finish`/`close` with a 1-second cap.
- **[logger.ts](logger.ts)** — `getLogger`, `shutdownLoggers`,
  `__resetLoggersForTests`. Holds the scope-keyed `Map<LoggerScope, Logger>`.

## Module dependency graph

```
caller.ts   → (leaf — node:fs, node:path)
dirs.ts     → @bb/config
formats.ts  → caller.ts
transports.ts → @bb/config, dirs.ts, formats.ts
logger.ts   → @bb/config, dirs.ts, transports.ts
index.ts    → re-exports from logger.ts, dirs.ts, winston (type only)
```

No cycles. `caller.ts` is the lowest leaf.

## Invariants enforced here

- `getLogger(scope)` is the only path to a winston logger; consumers do not
  build their own.
- File transport mode is `0600`; directory mode is `0700`.
- Daily rotation, gzip, and retention are entirely handled by
  `winston-daily-rotate-file` — no manual archive code lives here.
- The caller stack-walk skips `packages/logger/src/` so `logpath` always
  points at the consumer site, not internal logger code.
