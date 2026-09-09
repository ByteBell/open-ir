# `@bb/mcp/skills` — context

## Purpose

Bundled skill files served over the MCP resources channel
(`plumbline://skills/...`). This is data, not code: every file under
`skills/<skillName>/` is read verbatim from disk by
[`../src/resourcesSkills.ts`](../src/resourcesSkills.ts) and streamed
to the MCP client, which writes it to `~/.claude/skills/<skillName>/`
during session bootstrap.

## Layout contract

```
skills/
  <skillName>/
    SKILL.md             required — frontmatter + body. Parsed for `description`.
    <other>.md           optional — workflow / reference files referenced from SKILL.md.
```

`<skillName>` becomes the URI segment and the install-path leaf
(`~/.claude/skills/<skillName>/<filename>`). Use lowercase, hyphenated,
no spaces.

## What lives here in v1

- [`plumbline/`](plumbline) — the single skill shipped with the OSS
  engine. Covers the three retrieval tools and the default code-search
  workflow.

## How it is served

The package's `resourcesSkills.ts` resolves this directory via
`import.meta.url` (so dev `bun run` and built outputs both find it),
rebuilds the index from disk on each request, and exposes:

- `plumbline://skills/index` — JSON listing
- `plumbline://skills/{skillName}/{filename}` — markdown content

Edits to bundled skill files take effect on the next resource read; no
server restart required.

## Invariants

- **Only `.md` files are served.** Other extensions are ignored by the
  index builder and rejected by the per-file resolver.
- **`SKILL.md` is required** for a skill directory to appear in the
  index. Directories without one are silently skipped.
- **No path traversal.** Both the index builder and the per-file
  resolver reject any segment containing `/`, `\`, or a leading `.`.

## Adding a skill

1. Create `skills/<skillName>/SKILL.md` with YAML frontmatter
   (`name`, `description`, `user-invocable`, `argument-hint`).
2. Add per-task files (`<topic>.md`) referenced from `SKILL.md`.
3. Add a `README.md` to the new `skills/<skillName>/` directory
   following the existing `plumbline/README.md` template.
4. Restart the MCP server is **not** required — the index rebuilds
   from disk per request.
