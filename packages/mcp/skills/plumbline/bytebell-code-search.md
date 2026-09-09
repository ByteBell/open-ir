# Code search workflow

Use this workflow whenever the user asks you to find, explain, or trace code in a repository indexed by plumbline-server.

## The default loop

```
list_knowledge → smart_search → (optional) keyword_lookup → retrieve_file metadata → retrieve_file content
```

0. **`list_knowledge`** — call this first. Returns every indexed repo with its `knowledgeId` UUID, `repoName`, `state`, and `fileCount`. Match the user's intent to a row by `repoName`. Pick the `knowledgeId` of the row whose `state` is `PROCESSED` — skip rows in `CREATED / QUEUED / INGESTED / PROCESSING / FAILED`; they aren't queryable yet. Cross-repo investigations can skip the pick step and pass no `knowledgeId` to `smart_search`.

1. **`smart_search`** — one query against all six channels in parallel (purpose, paths, keywords, classes, functions, imports). Returns a fused, ranked list of files plus folder clusters. Omit `knowledgeId` for cross-repo search; pass `path: "packages/..."` to narrow to a monorepo subtree; pass `exclude: ["tests", "vendor"]` to drop noise.

2. **`keyword_lookup`** — only when you know the exact symbol you are looking for and `smart_search` did not surface it. The four `match` modes target distinct node types:
   - `match: "keyword"` (default) — file-level tags written by the analyzer (e.g. "auth", "caching")
   - `match: "class"` — class names; the returned `name` is the full signature including its approximate line range
   - `match: "function"` — function names; same signature shape as class
   - `match: "module"` — imported modules (e.g. "express", "./routes/users")

3. **`retrieve_file` `metadata`** — before reading any source, fetch metadata for the candidate files. The response gives you `purpose` and `summary` (the analyzer's narrative) and arrays of `classes[]`, `functions[]`, `imports[]`, `keywords[]`. Each class/function entry is a signature like `"createApplication (~L32-150): factory entry"` — that line range tells you exactly where to read.

4. **`retrieve_file` `content`** — armed with a line range, fetch the bytes. Use `fromLine` and `toLine` to target the specific section. Use `search` plus `contextLines` instead of paginated reads when you are looking for a specific symbol inside a known file.

## Bulk search across many files

When you need to find a string across a known set of files, do not loop — call `retrieve_file` with `operation: "bulk_search"`:

```
retrieve_file({
  operation: "bulk_search",
  knowledgeId: "<uuid>",
  paths: ["src/auth/login.ts", "src/auth/session.ts", "src/middleware/cors.ts"],
  search: "verifyToken",
  contextLines: 3
})
```

Returns matched files with line numbers + surrounding context, plus a `noMatch[]` list — a definitive "this string is absent" signal. For a fast existence check across many files, set `matchOnly: true`.

## Common patterns

Every example below assumes you have already called `list_knowledge` and resolved the `knowledgeId` for the user's repo (skipped here for brevity).

**"What repos do I have indexed?"** — `list_knowledge({})`. The response is the answer.

**"Where is X defined?"** — `keyword_lookup({ term: "X", match: "class" })` or `match: "function"`. Returns the file and the signature with line range.

**"What does this repo do?"** — `smart_search({ query: "main entry point", knowledgeId: "<uuid>" })` then `retrieve_file metadata` for the top results.

**"Trace usage of Y across the codebase"** — `keyword_lookup({ term: "Y", match: "function" })` to locate definitions, then `retrieve_file({ operation: "bulk_search", paths: [...], search: "Y" })` over the candidate files.

**"What changed in folder Z?"** — not supported by this server (no commit-aware retrieval). Suggest the user run `git log` directly.

## Do not

- Do not guess a `knowledgeId` from a repo name — it is always a UUID. Get it from `list_knowledge`.
- Do not pick a knowledge whose `state` is not `PROCESSED` — the graph is still being filled and queries will return partial or empty results.
- Do not call `retrieve_file content` without first calling `metadata` for that path.
- Do not paginate `content` reads when `search` would answer the question in one call.
- Do not expect PDFs, images, websites, or commit history — this server is code-only and snapshot-only.
