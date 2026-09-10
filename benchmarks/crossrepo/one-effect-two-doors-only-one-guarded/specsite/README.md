# spec-site pages for `hard-one-effect-two-doors-only-one-guarded`

One JSON spec page per file, laid out as `<repo>/<path in repo>.json`. The set of
files is the union of

- the 7 gold files in `../golden.json`, and
- the 67 files any arm returned in its `ranked.json`.

`MANIFEST.json` says, for each file, whether it is gold, run-returned or both,
which arms named it, the commit its page was taken from, and - when no page was
copied - why. 45 of 68 files have a page; 23 do not.

Pages come from /Users/sauravverma/programs/kube-package/temp/orgs/36af0f7a-fdf4-4497-9795-19d263268800/github (`<knowledgeId>/<owner>/<repo>/<scan>/<commit>/meta/spec-site/files/<sha>.json`).

Arms in this case:

- `claudecli_opus5_bare` - contributed
- `claudecli_opus5_mcp_graphify` - contributed
- `claudecli_opus5_mcp_plumbline` - contributed
- `claudecli_opus5_mcp_serena` - no ranked.json - arm not run (or run not finalized)
- `claudecli_opus5_mcp_turbovec` - contributed
- `opencode_hy4preview_mcp_plumbline` - no ranked.json - arm not run (or run not finalized)
