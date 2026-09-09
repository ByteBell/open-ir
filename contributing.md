# Contributing to Plumbline-public

Thanks for contributing. This document describes the automated checks that run on every commit and push, what each check enforces, and how to recover when one fails.

The toolchain is **Bun-only**. Husky wires three Git hooks: `pre-commit`, `commit-msg`, and `pre-push`. All checks are deterministic and run locally — there is no CI fallback for these gates.

---

## Quick reference

| Stage        | Hook         | Entry point                                                                     |
| ------------ | ------------ | ------------------------------------------------------------------------------- |
| `pre-commit` | staged files | [scripts/commit-validate.ts](scripts/commit-validate.ts)                        |
| `commit-msg` | message file | `commitlint --edit "$1"` (config: [commitlint.config.js](commitlint.config.js)) |
| `pre-push`   | full repo    | [scripts/push-validate.ts](scripts/push-validate.ts)                            |

Run the same checks manually:

```bash
bun run commit:validate   # pre-commit checks against staged files
bun run push:validate     # pre-push checks against full repo
bun run lint              # eslint
bun run format:check      # prettier --check
bun run typecheck         # tsc -b
```

---

## `pre-commit` — runs on staged files

Source: [scripts/commit-validate.ts:8-46](scripts/commit-validate.ts#L8-L46). If no files are staged, the hook is a no-op.

The checks run in this order. The first one to fail aborts the commit.

### 1. Lockfile guard

Blocks any staged `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`. Only `bun.lock` is permitted.

- **Rule:** [CLAUDE.md → Rule of Package Manager](CLAUDE.md)
- **Fix:** delete the foreign lockfile, run `bun install`, re-stage.
- **Source:** [checks-staged.ts:7-18](scripts/lib/checks-staged.ts#L7-L18)

### 2. Large file blocker

Blocks any single staged file larger than **1 MB**.

- **Why:** prevents accidental commits of binaries, dumps, or generated artifacts.
- **Fix:** use Git LFS, exclude the file via `.gitignore`, or remove it from the commit.
- **Source:** [checks-staged.ts:20-36](scripts/lib/checks-staged.ts#L20-L36)

### 3. Merge conflict markers

Scans staged text files for unresolved `<<<<<<< ` / `>>>>>>> ` markers.

- **Fix:** finish resolving the conflict, remove all marker lines, re-stage.
- **Source:** [checks-staged.ts:38-68](scripts/lib/checks-staged.ts#L38-L68)

### 4. Trailing whitespace + EOF newline

Every staged text file must:

- have **no trailing whitespace** on any line, and
- **end with a newline** character.

- **Fix:** `bun run format` — Prettier will repair both. Then re-stage.
- **Source:** [checks-staged.ts:70-105](scripts/lib/checks-staged.ts#L70-L105)

### 5. File size ≤ 300 lines

Applies to `.ts` and `.tsx` files, excluding `.test.ts`, `.spec.ts`, and `.d.ts`. Anything over **300 lines** is rejected.

- **Rule:** [CLAUDE.md → Rule of File Size](CLAUDE.md)
- **Fix:** split into single-responsibility files before committing.
- **Source:** [checks-rules.ts:8-40](scripts/lib/checks-rules.ts#L8-L40)

### 6. `README.md` presence

For every staged file under `packages/<pkg>/...`, the package root and every intermediate directory between the staged file and the package root must contain a `README.md` (either on disk or staged in this commit).

- **Rule:** [CLAUDE.md → Folder Context Rules](CLAUDE.md)
- **Fix:** create the missing `README.md` describing the directory's contract (responsibilities, public interface, invariants, dependencies, tier) and stage it in the same commit.
- **Source:** [checks-rules.ts:50-80](scripts/lib/checks-rules.ts#L50-L80)

### 7. Secrets scan (gitleaks)

If `gitleaks` is installed, runs `gitleaks protect --staged --redact --config .gitleaks.toml`. If `gitleaks` is **not** installed, the check is skipped with a warning — installing it (`brew install gitleaks`) is strongly recommended.

- **Fix on failure:** rotate the leaked credential, remove the secret from staged content, re-stage.
- **Source:** [checks-tools.ts:5-22](scripts/lib/checks-tools.ts#L5-L22)

### 8. `lint-staged`

Runs the matrix declared in [package.json](package.json#L22-L29):

| Glob                       | Commands                                                 |
| -------------------------- | -------------------------------------------------------- |
| `**/*.{ts,tsx,js,mjs,cjs}` | `prettier --write`, then `eslint --fix --max-warnings=0` |
| `**/*.{json,md}`           | `prettier --write`                                       |

ESLint is run with `--max-warnings=0`, so a single warning fails the commit. Auto-fixable issues are repaired in place; non-fixable issues abort.

- **Fix:** address the reported lint errors and re-stage. `bun run lint:fix` runs the same fixer over the entire repo.
- **Source:** [checks-tools.ts:24-31](scripts/lib/checks-tools.ts#L24-L31)

---

## `commit-msg` — commitlint

Runs `bunx --no -- commitlint --edit "$1"` with [@commitlint/config-conventional](https://github.com/conventional-changelog/commitlint) plus the local overrides in [commitlint.config.js](commitlint.config.js).

### Allowed types

```
feat  fix  refactor  perf  docs  style  test  chore  build  ci  revert
```

### Additional rules

| Rule                   | Constraint                                    |
| ---------------------- | --------------------------------------------- |
| `subject-case`         | must **not** be `upper-case` or `pascal-case` |
| `header-max-length`    | ≤ **100** characters                          |
| `body-leading-blank`   | blank line required between header and body   |
| `footer-leading-blank` | blank line required between body and footer   |

### Examples per type

| Type       | When to use                                                          | Example                                                         |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `feat`     | A new user-facing capability or public API surface.                  | `feat(ingest-github): add resumable clone phase`                |
| `fix`      | A bug fix in shipped behavior.                                       | `fix(mcp): handle empty result set in smart_search`             |
| `refactor` | Internal restructuring with no behavior change.                      | `refactor(queue): extract worker bootstrap into its own module` |
| `perf`     | A change whose primary goal is performance.                          | `perf(graph): batch neo4j writes during parse phase`            |
| `docs`     | Documentation only — `*.md`, JSDoc, `README.md`, `docs/`.            | `docs(arch): clarify cost-ledger lifecycle and reset semantics` |
| `style`    | Formatting, whitespace, semicolons — no code-meaning change.         | `style: apply prettier to packages/cli`                         |
| `test`     | Adding or correcting tests; no production-code change.               | `test(ingest-core): cover phase resume after process restart`   |
| `chore`    | Housekeeping that doesn't fit elsewhere (deps, scripts, configs).    | `chore(deps): bump bun to 1.1.34`                               |
| `build`    | Build system, bundler, package manifest, or release tooling.         | `build(package): publish @bb/types via workspace export map`    |
| `ci`       | CI configuration and pipelines (`.github/workflows/`, hook scripts). | `ci: run pre-push gates on pull_request as well as push`        |
| `revert`   | Reverts a prior commit; body should reference the reverted SHA.      | `revert: feat(ingest-github): add resumable clone phase`        |

Multi-line example with body and footer (note the blank lines required by `body-leading-blank` and `footer-leading-blank`):

```
fix(queue): dedupe retries by job-level idempotency key

Without a dedupe key, queue retries were re-running the parse phase
and double-writing nodes whenever a worker crashed mid-job.

Refs: BB-142
```

---

## `pre-push` — full-repo gates

Source: [scripts/push-validate.ts:41-56](scripts/push-validate.ts#L41-L56). All steps run regardless of earlier failures so you see the full picture before fixing.

| Step                     | Command                                   |
| ------------------------ | ----------------------------------------- |
| typecheck                | `bun run typecheck`                       |
| lint (full repo)         | `bun run lint`                            |
| format check (full repo) | `bun run format:check`                    |
| tests                    | _skipped — no test runner configured yet_ |

A failing step prints a red `✗` in the summary and exits non-zero, aborting the push. Fix and re-push.

---

## Bypassing hooks

Don't. The hooks exist because every rule they enforce has bitten the project before. If a hook is wrong:

1. Fix the underlying issue, **or**
2. Open a PR amending the hook script with the rationale.

Do **not** push with `--no-verify`, do **not** disable Husky locally, and do **not** add `--no-verify` shortcuts to scripts. If you genuinely need to land a hotfix that the hooks reject, escalate first.

---

## Setup

```bash
bun install        # installs deps and runs `husky` via the prepare script
```

Husky installs the hooks under `.husky/`. If hooks ever stop firing, run `bun run prepare` to reinstall them.

For the secrets scan, install gitleaks once:

```bash
brew install gitleaks
```

---

## Local development (hot reload)

Two root scripts run the binaries directly from source with `PLUMBLINE_DEV=1` (logs go to `./logs/` instead of `~/.plumbline/logs/`):

```bash
bun run dev:server   # PLUMBLINE_DEV=1 bun --watch packages/server/src/index.ts
bun run dev:cli      # PLUMBLINE_DEV=1 bun packages/cli/src/index.ts
```

`dev:server` uses `bun --watch`, which restarts the process automatically on any file change in the dependency graph — no `shutdown` / `boot` cycle needed between edits.

**Before running `dev:server`, run `plumbline shutdown`** to stop any server started via `plumbline boot`. Otherwise the watched process can't bind the configured server port (8080 by default) and exits with `EADDRINUSE`. `dev:server` does not manage Docker infra — bring up Neo4j with `plumbline boot` (then `plumbline shutdown` to free the port) or `docker compose -f infra/docker/docker-compose.yml up -d`.
