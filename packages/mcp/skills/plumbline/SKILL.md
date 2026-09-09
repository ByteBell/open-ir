---
name: plumbline
description: >
  Plumbline-public local knowledge graph. Discover, search, lookup, and
  retrieve from code repositories indexed locally by plumbline-server.
  TRIGGER when using: list_knowledge, smart_search, keyword_lookup,
  retrieve_file.
user-invocable: true
argument-hint: "[search query or task description]"
---

# Plumbline-public knowledge graph

Single-tenant local engine. The graph is `Knowledge → File → (Keyword | Class | Function | Module)` — flat, no commit versioning, no multi-tenant scoping. Every `Knowledge` node carries a `repoName` (e.g. `anthropics/claude-code`) and a `knowledgeId` (UUID).

`knowledgeId` is **always** a UUID — never a repo name or slug. Call `list_knowledge` first to enumerate the UUIDs available on this server.

## Tools

| Tool             | When to use                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `list_knowledge` | First call — enumerate every indexed repo with its `knowledgeId`, `repoName`, `state`, and `fileCount`     |
| `smart_search`   | Default search — fuses six channels in one call (purpose, paths, keywords, classes, functions, imports)    |
| `keyword_lookup` | Find specific named entities — exact class names, function names, keywords, or imported modules            |
| `retrieve_file`  | Get file metadata (purpose, summary, classes/functions list) or content (line range or search-within-file) |

## Always-on guardrails

1. **`list_knowledge` first.** Always call `list_knowledge` at the start of a session (or whenever you need a `knowledgeId` you don't have). The `knowledgeId` is always a UUID — never guess it from a repo name. Pick the row whose `repoName` matches the user's intent and whose `state` is `PROCESSED`. Skip rows in any other state — they aren't queryable yet.
2. **`metadata` before `content`.** Always call `retrieve_file` with `operation: "metadata"` before `operation: "content"`. The metadata response carries `classes[]` and `functions[]` whose signatures embed approximate line ranges (`"AuthService (~L12-58): handles login"`) — use those line ranges to target your content read instead of paginating blindly.
3. **Max 3 consecutive `retrieve_file` calls.** If you find yourself reading file after file without progress, stop and re-orient with `smart_search` or `keyword_lookup`. Three reads is usually enough to confirm or deny a hypothesis.
4. **Use `bulk_search`, not a loop.** When you need to find a string across many files, call `retrieve_file` with `operation: "bulk_search"` and an array of paths instead of N sequential `content+search` calls.
5. **No cross-repo cap.** Omitting `knowledgeId` searches every indexed repository. Use it freely; the response trims itself to a token budget.

## Per-task workflows

For code search, file location, and reading: read `plumbline-code-search.md`.

## What this server does NOT have

- PDF, image, or website tools — code only.
- Commit-aware retrieval — there is one snapshot per indexed repo.
- An LLM-based answer synthesizer (`generate_answer`) — write your own answer in chat.
- Conversation capture or feedback hooks — none.
- Auth — runs unauthenticated on `127.0.0.1`.
