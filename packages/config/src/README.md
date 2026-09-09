# `@bb/config/src` — context

Implementation of `@bb/config`. See [../README.md](../README.md) for the
package-level contract; this file documents how the source tree is split.

## Files

- **[index.ts](index.ts)** — public re-exports. The only entry point other
  packages may import. Anything not re-exported here is internal.
- **[paths.ts](paths.ts)** — `getPlumblineHome`, `getConfigPath`, and the
  cache-invalidator registry. Holds the `testHomeOverride` slot set by
  `__setPlumblineHomeForTests` and the `homeResolver` slot set by
  `setPlumblineHomeResolver`. `getPlumblineHome` consults the test override
  first, then the resolver (if set and returning non-null), then falls back
  to `~/.plumbline`. Pure: imports nothing from the rest of the package.
- **[schema.ts](schema.ts)** — Zod `configSchema`, `PlumblineConfig` type,
  `ConfigValueMap`, `DEFAULT_CONFIG`, `REQUIRED_KEYS` (infra-always),
  `requiredKeysFor(provider)` (combines infra + provider-specific keys
  driven by `Config.LlmProvider`), `HINTS`, and the
  `readField` / `writeField` switch helpers. Imports the `Config` enum from
  `@bb/types` and re-exports it for intra-package convenience.
- **[loader.ts](loader.ts)** — `loadConfig` (memoized), `getConfigValue`,
  `isConfigComplete`. Subscribes to the cache invalidator on module load.
- **[writer.ts](writer.ts)** — `ensurePlumblineHome`, `setConfigValue`, atomic
  `tmp → fsync → rename` write. Notifies the invalidator after a successful
  write. `ensurePlumblineHome` writes `DEFAULT_CONFIG` on first run, and on
  subsequent runs migrates the on-disk file by rewriting it with merged
  defaults whenever any top-level schema key is missing — so PRs that add
  defaulted fields populate existing installs at next boot, not just fresh
  installs. Idempotent: a second call with no missing keys is a no-op.

`ConfigIncompleteError` lives in `@bb/errors`, not here.

## Module dependency graph

```
loader.ts → schema.ts, paths.ts, writer.ts
writer.ts → schema.ts, paths.ts
paths.ts  → (leaf — node:os, node:path)
schema.ts → @bb/types (Config enum), zod
index.ts  → re-exports from all above
```

No cycles. `paths.ts` is the lowest leaf and owns the cache-invalidation
seam so that `loader.ts` and `writer.ts` never have to import each other.

## Invariants enforced here

- Required-field check (`isConfigComplete`) treats empty strings as missing.
- Atomic write: `config.json.tmp` is `openSync` → `writeSync` → `fsyncSync` →
  `closeSync` → `renameSync`.
- File mode `0o600` on `config.json`; directory mode `0o700` on `~/.plumbline/`.
- `loadConfig` always calls `ensurePlumblineHome` first — never reads a missing
  file.
- **`org_id` is locked to `"local"` in OSS builds.** The Zod schema for
  `org_id` defaults to `"local"` and `.refine`s that no other value is
  accepted — a hand-edited `config.json` with any other `org_id` makes
  `loadConfig()` throw and the server refuses to boot. `writeField`
  throws on `Config.OrgId`, and `keyMap.ts` in `@bb/cli` deliberately
  has no entry for it so `plumbline set org_id …` is rejected at the CLI.
  Per-job org overrides for downstream consumers live on the
  payload (`GithubIndexPayload.orgId?`), not in config.json.
