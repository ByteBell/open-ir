# `@bb/ingest-github/src/strategies/flat-folder/prompts`

Every LLM prompt the flat-folder strategy uses, with the field-block constant
as the single source of truth so file / chunk / condense prompts can never
drift apart.

## Files

- `file-analysis-fields.ts` — `FILE_ANALYSIS_FIELDS_BLOCK`. Authoritative list
  of the JSON keys + per-field instructions. Imported by every other prompt.
  `sectionMap` entries carry four fields: `name`, `description`, `start_line`,
  `end_line` (inclusive 1-indexed, non-overlapping, within total line count).
  The chat-mcp `retrieve_file(metadata)` workflow expects the line ranges so
  callers can pick a targeted `fromLine`/`toLine` without re-reading the file.
- `file-analysis.ts` — single-call per-file prompt
  (`COMBINED_CODE_ANALYSIS_SYSTEM_PROMPT` + `buildFileAnalysisUserPrompt`).
- `chunk.ts` — per-chunk prompt for the big-file path. Identical field block,
  scoped to "this chunk only".
- `condense.ts` — recursive condense prompt with merge rules.
- `folder-summary.ts` — `FOLDER_ANALYSIS_SYSTEM_PROMPT` + `folderAnalysisUserPrompt`.
  Flat: only direct children of a folder are passed in.
- `repo-summary.ts` — `REPO_SUMMARY_SYSTEM_PROMPT`, `buildRepoPromptFromFolders`,
  `buildRepoMergePrompt`, `repoFolderInfosFrom`.
- `backfill.ts` — `BACKFILL_SYSTEM_PROMPT` + `buildBackfillUserPrompt`,
  used by the phase-3 backfill pass under `../backfill/fields.ts` to
  re-derive the full extended-field set when condense leaves them
  empty: `keywords`, `ontologyConcepts`, `businessEntities`,
  `systemCapabilities`, `sideEffects`, `configDependencies`,
  `dataFlowDirection`, `integrationSurface`, `contractsProvided`,
  `contractsConsumed`, `sectionMap`. The prompt mirrors the field
  block in `file-analysis-fields.ts` so the two stay in lockstep.

## Invariants

- Prompts are pure functions of typed inputs. No I/O, no LLM calls, no document store.
- The field block lives in one file. Any change to the JSON schema starts here.
- Prompts never depend on `pipeline/`, `adapters/`, or `handlers/`.
