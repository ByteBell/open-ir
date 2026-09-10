# Failed attempt — not a measurement

`claudecli_opus5_mcp_turbovec`, 2026-09-10 04:49. Exit 0, $0.177, 3 turns, 20s wall.

The turbovector MCP server never connected (`CONNECTION_CLOSED`), so the arm had
NO tools at all. It correctly refused to emit a ranked array rather than answer
from parametric memory, and said so — the run is a harness failure, not a
retrieval result. Nothing here should be scored.

Root cause: a tree-wide rewrite of absolute paths to `~/...` at 04:47 broke four
separate layers, none of which expand a tilde:

1. run.sh `[ -f "~/..." ]` and `--mcp-config "~/..."` (quoted tilde)
2. sandbox.sb `(subpath "~/...")` — every deny rule inert, so the profile
   was effectively `(allow default)`: gold, sibling results and
   all 15 checkouts were readable. Gate 4 caught this.
3. mcp_turbovector.json args path to the server script
4. turbovector_mcp.py:16 `IDX = Path("~/...")`

All four fixed; `.tilde.bak` kept beside each. Server verified by a direct MCP
handshake: initialize OK, tools = search/get_file/read_lines/index_info.
