#!/bin/zsh
# claudecli_opus5_mcp_graphify — hard-delete-is-not-terminal-and-its-cascade-is-not-scoped
# The shared merged graphify graph is the only search surface.
# ONE fresh isolated headless session. Isolation is kernel-enforced by sandbox-exec
# (sandbox.sb), not by convention: gold and every other arm's output are unreadable
# from inside.
#
# NOTE: --safe-mode must NOT be used; it disables MCP servers along with every other
# customization, which silently leaves the model with no tools.
# NOTE: every path here is ABSOLUTE. "~" does not expand inside double quotes in
# test -f, nor inside a sandbox-exec subpath, and both failures are silent-ish.
set -e
R=/Users/sauravverma/programs/benchmarks/react-ecosystem
CASE=$R/cross-repo/hard-delete-is-not-terminal-and-its-cascade-is-not-scoped
ARM=$CASE/claudecli_opus5_mcp_graphify
IDX=$R/cross-repo/_indexes
CWD=/tmp/xrepo-runs/hard-delete-is-not-terminal-and-its-cascade-is-not-scoped-graphify
PROFILE=$ARM/sandbox.sb
CLAUDE=/Users/sauravverma/.nvm/versions/node/v24.9.0/bin/claude

# --- gate 1: every checkout on its pinned commit ---
check() { [ "$(git -C $R/$1 rev-parse HEAD)" = "$2" ] || { echo "CHECKOUT DRIFT: $1"; exit 1; } }
check redux          3aa561f9fc13f3287e6d83764f85fe0e82437c5f
check redux-toolkit  b1c5130154c454ca8387f55da6122fcb507c560c
check react-redux    ad5d1e0816d0cb1464b25cf2853f2a7d73433f5b
check reselect       8d87c27b75f55883629be75d1eae1c27832d907a
check redux-thunk    184205d49f707c6f203269e0d39ad85824801816
check react          3a717e42438afac81020cdec297dadb5613a4304
check jotai          5c4ca26b0db5571114be58393e17854a771f7790
check zustand        beca84e600e4e250f6b244d22878e72948f331c7
check db             7f0fa36ff6d48b0494ed5f6a1223fd18c317e41f
check xyflow         360f5b13e2bc6899ea06b4be1a49b068d86926cf
check query          46d7f02f1c7b9fcd3255082cc7103e8bfa3dab76
check table          d08af367e11c539bb7e18c2472aa761149ef6db6
check tldraw         5590d14d8edd4faab7dc1177b6e1adb28876fd23
check redux-devtools f4b4668c30ae08920c59a76cc4629c35c16ef0fa
check router         3dee5b2e9453d01a3172c73426959007b290b3fc

# --- gate 2: this surface's index must be present ---
[ -f "$IDX/graphify/merged/graphify-out/graph.json" ] || { echo "MISSING merged graph"; exit 1; }
[ -f "$IDX/graphify_mcp/mcp_graphify_abs.json" ]      || { echo "MISSING mcp_graphify_abs.json"; exit 1; }

# --- gate 3: never re-attempt an arm that already ran ---
[ -f $ARM/raw_response.json ] && { echo "ALREADY RUN - refusing to re-attempt"; exit 1; }

# --- gate 4: the sandbox must actually be blinding the gold ---
# The file must EXIST before its unreadability means anything. A stale path made this
# check pass because `cat` failed on a missing file, not on a denied one.
[ -f $CASE/golden.json ] || { echo "NO golden.json - gate 4 cannot prove anything"; exit 1; }
sandbox-exec -f $PROFILE /bin/cat $CASE/golden.json >/dev/null 2>&1 \
  && { echo "SANDBOX LEAK: golden.json is readable"; exit 1; }
# and it must NOT be blinding the surface
sandbox-exec -f $PROFILE /usr/bin/head -c 16 $IDX/graphify/merged/graphify-out/graph.json >/dev/null 2>&1 \
  || { echo "SANDBOX OVER-DENY: merged graph unreadable"; exit 1; }

mkdir -p $CWD
ST=$(date +%s)
( cd $CWD && DISABLE_PROMPT_CACHING=0 sandbox-exec -f $PROFILE "$CLAUDE" -p "$(cat $ARM/run_prompt.txt)" \
    --model claude-opus-5 \
    --setting-sources "" --disable-slash-commands \
    --mcp-config "$IDX/graphify_mcp/mcp_graphify_abs.json" --strict-mcp-config \
    --allowedTools "mcp__graphify__query_graph" "mcp__graphify__get_node" "mcp__graphify__get_neighbors" "mcp__graphify__get_community" "mcp__graphify__god_nodes" "mcp__graphify__graph_stats" "mcp__graphify__shortest_path" \
    --disallowedTools Bash Read Write Edit Grep Glob WebFetch WebSearch Task NotebookEdit TodoWrite ReportFindings \
    --max-budget-usd 40 \
    --output-format json < /dev/null ) > $ARM/raw_response.json 2> $ARM/stderr.log
echo "wall_seconds=$(( $(date +%s) - ST ))" > $ARM/wall.txt
echo "arm finished: hard-delete-is-not-terminal-and-its-cascade-is-not-scoped graphify $(cat $ARM/wall.txt)"
echo
echo "next: python3 $R/score_arm.py cross-repo/hard-delete-is-not-terminal-and-its-cascade-is-not-scoped claudecli_opus5_mcp_graphify"
