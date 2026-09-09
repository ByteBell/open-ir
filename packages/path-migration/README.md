# `@bb/path-migration` — context

## Tier

Utility. Depends only on Kernel (`@bb/types` for the path-layout helpers and `KnowledgeDoc`). Imported by Binaries (`@bb/cli` for `plumbline migrate paths`, `@bb/server` for boot-time reconciliation). Holds no DB connection and performs no I/O beyond the local filesystem.

## Responsibility

Reconciles the **legacy on-disk layout** with the **commit-scoped layout**:

- Legacy: `<home>/repos/<knowledgeId>/` (clone) and `<home>/repos/.meta/<knowledgeId>/...` (meta-output).
- Commit-scoped: `<home>/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/...`.

Given the set of knowledge known to the DB, it:

1. **Migrates** every knowledge with a derivable target (commit + repo url, or a synthetic commit for local sources) by moving its clone + meta-output under the commit-scoped tree.
2. **Abandons** legacy directories with no backing DB record — they can never be migrated (no doc to derive a target), so they are deleted and reported. This is what lets boot self-heal after a DB reset leaves orphaned dirs behind.

The package never opens a DB connection: the caller lists knowledge and passes the docs in. This keeps it usable from both the CLI and the server boot path — each connects the active `@bb/db` provider itself — without either deployable importing the other.

## Invariants

1. **Never destroys live data.** Only directories whose id is absent from the supplied `knowledgeDocs` are deleted. A knowledge that has a DB record but cannot be migrated (missing commitId / repoUrl) is reported under `skippedNoCommit` / `skippedNoRepoUrl` and left on disk — callers decide what to do.
2. **`dryRun` touches nothing.** It computes the same summary (including `abandoned`) without moving or deleting.
3. **Idempotent.** A target already present in the new layout is recorded under `skippedAlready` and left untouched; re-running is safe.
4. **Cross-device safe.** Moves fall back to recursive copy + remove on `EXDEV`.

## External dependencies

- `node:fs/promises`, `node:path` — filesystem moves.
- `@bb/types` — `plumblinePathsFor`, `repositoryDirFor`, `parseGithubOwnerRepo`, `RepoLocation`, `KnowledgeDoc`.
