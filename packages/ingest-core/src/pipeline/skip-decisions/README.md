# `@bb/ingest-github/src/pipeline/skip-decisions`

LLM-backed gate that decides whether to ingest a scanned file. Mirrors kube's
`StreamingFileScanner.shouldProcessUnknownExtension` but trimmed for the
single-tenant public layout.

## Decision flow

The static reject lists (steps 1-4) are not the raw `SEED_*` sets but the
**effective ignore sets** (`effective.ts`): the seed/legacy defaults overlaid
with any per-job `IgnoreOverrides` the enterprise wrapper resolved from an org's
config and stamped on the payload. With no overrides the effective sets equal the
built-in defaults, so OSS standalone behaves exactly as before. `makeSkipDecider`
takes `deps.ignoreSets`; absent, it calls `buildEffectiveIgnoreSets()` (pure
defaults).

```
1. Reject if any directory segment is in effectiveSets.directories.
2. Reject if the filename is in effectiveSets.filenames.
3. Reject if the extension is in effectiveSets.extensions.
4. Reject if the filename matches any glob in effectiveSets.globs (e.g. *.tfvars, .env.*).
5. Accept if the extension is in KNOWN_LANGUAGE_EXTENSIONS (fast-path, no LLM).
6. Cache lookup by `extensions:<ext>` (or `filenames:<name>` when extensionless).
7. Cache miss → askYesNoLLM with the first N chars of the file content.
8. Persist verdict to ~/.plumbline/llmDecisions.json. LLM failure → reject + cache the rejection.
```

Steps 1-6 are pure CPU + cached lookup — they run synchronously via
`decideStatic`. Step 7 is the slow LLM branch; `decide` performs it
inline, while `decideAndDeferSave` performs it without flushing the
cache to disk so a batched caller can `persist()` once at the end of
its batch.

## Public methods (`SkipDecider`)

```ts
interface SkipDecider {
  decide(input): Promise<SkipDecision>; // legacy single-shot path
  decideStatic(input): SkipDecision | null; // sync; null = needs LLM
  decideAndDeferSave(input): Promise<SkipDecision>; // LLM call, no disk save
  persist(): void; // flush cache to disk once
}
```

- `decide` — the original single-shot API. Calls `decideStatic`; if that
  returns `null`, runs the LLM call and `persist()`s the cache. Used by
  the legacy `walk()` in `scan.ts` when no shared limiter is passed
  (e.g. custom `SourceFactory` consumers that don't opt into two-pass).
- `decideStatic` — synchronous. Returns the resolved `SkipDecision` for
  steps 1-6; returns `null` to signal "would need an LLM call". Used by
  the two-pass scan to categorise files without blocking the walk.
- `decideAndDeferSave` — runs the LLM call and mutates the in-memory
  cache but does **not** flush to disk. Scan calls this concurrently
  for unique extension/filename keys under a shared limiter; the disk
  write happens once via `persist()` after the batch.
- `persist` — best-effort cache flush; swallows I/O errors.

## Files

- `seed.ts` — loads the four bundled JSON files (directory/filename/pattern/extension lists)
  at module-init time via static `import ... with { type: "json" }`. Exposes
  `SEED_DIRECTORIES`, `SEED_FILENAMES`, `SEED_EXTENSIONS`, `SEED_GLOBS`,
  `KNOWN_LANGUAGE_EXTENSIONS`, and `matchesAnyGlob`. Compiles globs once and
  caches the resulting `RegExp` for reuse.
- `cache.ts` — load/save `~/.plumbline/llmDecisions.json` with atomic write
  (write-tmp + fsync + rename + mode 0600). Mirror's kube's JSON shape so
  users can hand-edit `ignore: true → false` to permanently un-ignore an
  extension.
- `prompts/skip-decision.ts` — verbatim port of kube's YES/NO system
  prompt + user-prompt builder. Lives under `prompts/` to match the
  convention used by `strategies/flat-folder/prompts/`.
- `decider.ts` — `makeSkipDecider(deps)` returns a `SkipDecider` (port type
  from `src/types/pipeline.ts`). Reads `Config.SkipDecisionEnabled` once at
  factory time; when disabled the decider degrades to "accept everything
  past the static blocklist". The LLM branch forwards
  `SkipDeciderInput.llmCallContext` (when set by the runner) into
  `askYesNoLLM` so per-job credentials reach the decision call. The four
  methods (`decide`, `decideStatic`, `decideAndDeferSave`, `persist`) share
  one internal `staticDecision()` helper so the seed-list + cache-lookup
  branch is defined exactly once.
- `effective.ts` — `buildEffectiveIgnoreSets(overrides?)` overlays the seed +
  legacy defaults (imported from `#src/pipeline/filters.ts`: `SKIP_DIRS`,
  `SKIP_FILES`, `BINARY_EXTENSIONS`) plus `SEED_GLOBS` with an optional per-job
  `IgnoreOverrides` add/remove patch. `add` adds a pattern; `remove` un-ignores a
  built-in default. Also exports `defaultIgnorePatternLists()` — the defaults as
  plain sorted arrays, consumed by the enterprise ignore-manager via the
  `@bb/ingest-github/ignore-defaults` subpath export so a UI can render and toggle
  them. The effective sets are also passed to `scan.ts` for directory-walk pruning
  and the path filter, so scan and decider filter against the identical set.
- `seed-data/` — the five JSON files copied from kube's `shared/`:
  `directoryIgnore.json`, `filenameIgnore.json`, `ignorePatterns.json`,
  `extensions.json`, `llmDecisionsBase.json`. `llmDecisionsBase.json` is
  currently unused by the runtime but kept here for reference; a future
  enhancement may pre-seed the cache file from it on first install.

## Imports allowed

- Sibling files in this folder may import each other.
- Down: `src/types/pipeline.ts`.
- Up: `@bb/config`, `@bb/types`, `@bb/llm`, `@bb/logger`, `node:*`.
- `effective.ts` only: `#src/pipeline/filters.ts` for the legacy-merged default
  sets. This is the one sanctioned reach into `filters.ts` (it owns the
  defaults). The rest of this folder must not import `../scan.ts`, `../filters.ts`,
  or `../../strategies/*`.

## Invariants

- The static (steps 1-5) and cached (step 6) paths must not perform I/O
  beyond reading the cache file once at factory time. Only the LLM branch
  reads file content from disk, and even that is bounded by
  `Config.SkipDecisionMaxCharsForLlm`.
- `decide` flushes to disk immediately after each LLM verdict — same
  semantics as before this refactor, so crash mid-scan does not lose
  decisions made earlier in the run when the legacy inline path is in use.
- `decideAndDeferSave` does **not** flush; the batched caller (two-pass
  scan) is responsible for calling `persist()` exactly once after the
  parallel batch resolves. This avoids racing tmp/rename writes when many
  unique extensions resolve concurrently. Crash recovery in two-pass mode
  is acceptable because the batch is short and re-running the scan
  re-resolves the same decisions.
- LLM failure defaults to reject and caches the rejection — matches kube's
  one-shot-rule behavior. Users can hand-edit the cache to revisit.
- The decider is process-local: tests may construct one with `cachePath`
  pointing at a temp file to avoid touching the real `~/.plumbline/`.
