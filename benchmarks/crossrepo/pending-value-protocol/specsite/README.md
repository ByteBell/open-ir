# spec-site pages for `medium-pending-value-protocol`

One JSON spec page per file, laid out as `<repo>/<path in repo>.json`. The set of
files is the union of

- the 9 gold files in `../golden.json`, and
- the 89 files any arm returned in its `ranked.json`.

Every page is taken at that repo's ROSTER PIN — the same commit the arms searched.
A repo whose pinned commit has no page for a file gets no page at all; pages are
never borrowed from another commit.

`MANIFEST.json` says, for each file, whether it is gold, run-returned or both,
which arms named it, the pinned commit, where the page came from (`local` tree or
`s3` mirror), and - when no page was copied - why, including the scan-manifest
`kind` when that is what explains it. 79 of 90 files have a page
(28 fetched from the mirror); 11 do not.

Arms in this case:

- `claudecli_opus5_bare` - contributed
- `claudecli_opus5_mcp_graphify` - contributed
- `claudecli_opus5_mcp_plumbline` - contributed
- `claudecli_opus5_mcp_serena` - no ranked.json - arm not run (or run not finalized)
- `claudecli_opus5_mcp_turbovec` - contributed
- `claudecli_sonnet5_bare` - contributed
- `opencode_hy4preview_mcp_plumbline` - no ranked.json - arm not run (or run not finalized)
