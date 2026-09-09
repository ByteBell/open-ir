# `infra/` — context

## Purpose

Operational artefacts that are not TypeScript workspace packages.
Today this dir holds the local Docker compose stack used by
`plumbline boot`. Future additions might include a Helm chart, a
production Compose file, or platform-specific service files —
each in its own subdirectory with its own `README.md`.

`infra/` is **not** part of the Bun workspace and never appears in
`tsconfig.json` references. Code under `packages/cli/` consumes
`infra/docker/` via `child_process` only — no imports cross the
boundary.

## Subdirectories

- [`docker/`](docker/README.md) — single-service `docker-compose.yml`
  (Neo4j) plus the gitignored `.env` file the CLI generates on first
  boot. Version pinned at the major level (`neo4j:5`). The document
  store and the job queue are SQLite and have no container.

## Adding a new infra artefact

1. Create `infra/<name>/` with a `README.md` describing the contract,
   versions, lifecycle, and which CLI command consumes it.
2. If the artefact is consumed by the CLI, route the orchestration
   through a small dedicated module under `packages/cli/src/` (mirror
   the `dockerInfra.ts` pattern). Never import the new artefact from
   any TypeScript package — keep `infra/` outside the import graph.
