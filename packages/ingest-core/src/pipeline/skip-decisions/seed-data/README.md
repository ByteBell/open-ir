# `@bb/ingest-github/src/pipeline/skip-decisions/seed-data`

Static reject / known-extension data, copied verbatim from kube's
`services/knowledge-server/repo/src/knowledge/github/shared/*.json`. Loaded
at module-init time by [../seed.ts](../seed.ts) via
`import data from "./<file>.json" with { type: "json" }`.

## Files

- `directoryIgnore.json` — `string[]` of directory basenames that should
  always be skipped. Examples: `.git`, `node_modules`, `__pycache__`,
  `.mypy_cache`. Merged with the `type: "directory"` entries from
  `ignorePatterns.json` into `SEED_DIRECTORIES` (a `ReadonlySet<string>`).
- `filenameIgnore.json` — `string[]` of exact filenames that should always
  be skipped. Examples: `CODEOWNERS`, `OWNERS`, `Makefile`, `Dockerfile`.
  Merged with the `type: "exact"` entries from `ignorePatterns.json` into
  `SEED_FILENAMES`.
- `ignorePatterns.json` — categorised reject patterns. Each top-level key
  groups related patterns; each entry is `{ type: "directory" | "exact" |
"extension" | "glob" | "binary", pattern: string }`. The seed module
  fans these out by `type`:
  - `type: "extension"` entries → `SEED_EXTENSIONS` (normalised to lowercase
    with a leading `.`).
  - `type: "glob"` entries → `SEED_GLOBS`, compiled to `RegExp` on first
    use and cached in a module-local map.
  - `type: "binary"` entries → not currently consumed (binaries are caught
    via `BINARY_EXTENSIONS` in `../../filters.ts` + the null-byte heuristic
    in `looksBinary`).
- `extensions.json` — `Record<string, string>` mapping bare extension
  (without leading dot) to a language name. Drives `KNOWN_LANGUAGE_EXTENSIONS`
  in `../seed.ts`; if a file's extension is in this map the decider
  short-circuits with `"accept"` and the strategy can use the language
  hint without re-asking the LLM.
- `llmDecisionsBase.json` — kube's pre-seeded baseline cache of
  `{ directories|extensions|filenames|filename_globs: Record<name, { ignore: boolean, source: "hardcoded" }> }`.
  Currently **not consumed** by the public runtime. Kept here for reference
  and as the seed source for a future enhancement that would copy these
  entries into `~/.plumbline/llmDecisions.json` on first install (so users
  start with kube's curated reject list pre-loaded rather than discovering
  it one LLM call at a time).

## Invariants

- These files are data, not code. Edits should come from upstream kube
  (`services/knowledge-server/repo/src/knowledge/github/shared/`) rather
  than being hand-curated here.
- Adding a new reject category means: edit the JSON, re-run, no code
  change in `../seed.ts` is required as long as the new patterns use
  existing `type` values (`directory`/`exact`/`extension`/`glob`).
- A new `type` value requires extending `../seed.ts` to fan it out and
  the consumer (`../decider.ts`) to use it.
