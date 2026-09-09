# `@bb/ingest-github/src/strategies/concept-graph/prompts`

LLM prompts used by the concept-graph enrichment phase. Pure string
builders — no I/O, no schemas, no LLM calls.

## Files

- `enrich-file.ts` — system + user prompts for the per-file MCP
  enrichment loop driven by `phases/enrich-one-file.ts`. Exports:
  - `buildEnrichFileSystemPrompt(): string` — the role / output-shape
    instructions handed to the model on every per-file call.
  - `buildEnrichFileUserPrompt(input: EnrichFilePromptInput): string`
    — assembles the per-file user message from the file's
    `CondensedFileAnalysis`, the running list of known concepts /
    contracts (so the model reuses slugs instead of inventing new
    ones), and the relative path.
  - `EnrichFilePromptInput` — typed input shape for the user-prompt
    builder.

## Invariants

- Prompts are pure functions of typed inputs. No `await`, no document store,
  no Neo4j, no `process.*`.
- The output contract these prompts describe MUST match
  `enrichment-schema.ts` exactly. When one changes, the other
  changes in the same PR — drift means every enrichment call fails
  validation.
- Prompts do not depend on `phases/`, `pipeline/`, or any adapter.
  Phases import prompts, never the reverse.

## Tier

Strategy support (under `concept-graph`).
