# `@bb/mcp/skills/plumbline` — context

## Purpose

The single skill bundled with `plumbline-public`. Teaches an MCP-capable
LLM client how to use the three retrieval tools (`smart_search`,
`keyword_lookup`, `retrieve_file`) against the public knowledge graph.

## Files

- **[SKILL.md](SKILL.md)** — entry document. YAML frontmatter sets
  `name: plumbline`, `description`, `user-invocable: true`,
  `argument-hint`. Body is a one-paragraph description of the public
  graph, a tool quick-reference, and the always-on guardrails distilled
  from the private repo's empirical analysis (UUID-not-name,
  `metadata` before `content`, max 3 consecutive `retrieve_file`
  calls, prefer `bulk_search` over loops, no cross-repo cap).
- **[plumbline-code-search.md](plumbline-code-search.md)** — the
  default code-search workflow. Walks the LLM through the loop:
  `smart_search → keyword_lookup → retrieve_file metadata →
retrieve_file content`. Includes common patterns (where-is-X-defined,
  what-does-this-repo-do, trace-usage-of-Y) and the "do not" list.

## Distribution

These files are read from disk by
[`../../src/resourcesSkills.ts`](../../src/resourcesSkills.ts) on every
`plumbline://skills/index` and `plumbline://skills/plumbline/<filename>`
fetch. The MCP client writes them to `~/.claude/skills/plumbline/` during
session bootstrap.

## Editing

- Keep each file ≤ 300 lines (CLAUDE.md _Rule of File Size_ applies to
  docs too).
- Update both files together when behaviour changes — `SKILL.md` is
  the table of contents and guardrails; `plumbline-code-search.md` is
  the per-task workflow that links back to the guardrails.
- The `description` field in `SKILL.md` frontmatter is what the LLM
  sees as the skill's one-line summary in `plumbline://skills/index` —
  keep it punchy.

## What deliberately is NOT here

- No PDF, image, website, or commit-aware workflow files. The OSS
  engine is code-only and snapshot-only; promising features the server
  cannot deliver only confuses the LLM.
- No chat-capture or hooks installation steps. Those belong to the
  closed-source product surface.
- No `generate_answer` mandate. The OSS engine has no answer-synthesis
  tool; the LLM writes its own answer in chat.
