#!/bin/zsh
# claudecli_opus5_mcp_turbovec — hard-lifecycle-fires-for-a-branch-that-was-never-shown
# the shared cross-repo turbovec vector index is the only search surface.
# ONE fresh isolated headless session. Isolation is kernel-enforced by sandbox-exec
# (sandbox.sb), not by convention: gold and every other arm's output are unreadable
# from inside.
#
# NOTE: --safe-mode must NOT be used; it disables MCP servers along with every other
# customization, which silently leaves the model with no tools.
set -e
ARM=/Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/hard-lifecycle-fires-for-a-branch-that-was-never-shown/claudecli_opus5_mcp_turbovec
CWD=/tmp/xrepo-runs/hard-lifecycle-fires-for-a-branch-that-was-never-shown-turbovec
PROFILE=$ARM/sandbox.sb
CLAUDE=/Users/sauravverma/.nvm/versions/node/v24.9.0/bin/claude

# --- gate 1: every checkout on its pinned commit ---
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/redux rev-parse HEAD)" = "3aa561f9fc13f3287e6d83764f85fe0e82437c5f" ] || { echo "CHECKOUT DRIFT: redux"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/redux-toolkit rev-parse HEAD)" = "b1c5130154c454ca8387f55da6122fcb507c560c" ] || { echo "CHECKOUT DRIFT: redux-toolkit"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/react-redux rev-parse HEAD)" = "ad5d1e0816d0cb1464b25cf2853f2a7d73433f5b" ] || { echo "CHECKOUT DRIFT: react-redux"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/reselect rev-parse HEAD)" = "8d87c27b75f55883629be75d1eae1c27832d907a" ] || { echo "CHECKOUT DRIFT: reselect"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/redux-thunk rev-parse HEAD)" = "184205d49f707c6f203269e0d39ad85824801816" ] || { echo "CHECKOUT DRIFT: redux-thunk"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/react rev-parse HEAD)" = "3a717e42438afac81020cdec297dadb5613a4304" ] || { echo "CHECKOUT DRIFT: react"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/jotai rev-parse HEAD)" = "5c4ca26b0db5571114be58393e17854a771f7790" ] || { echo "CHECKOUT DRIFT: jotai"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/zustand rev-parse HEAD)" = "beca84e600e4e250f6b244d22878e72948f331c7" ] || { echo "CHECKOUT DRIFT: zustand"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/db rev-parse HEAD)" = "7f0fa36ff6d48b0494ed5f6a1223fd18c317e41f" ] || { echo "CHECKOUT DRIFT: db"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/xyflow rev-parse HEAD)" = "360f5b13e2bc6899ea06b4be1a49b068d86926cf" ] || { echo "CHECKOUT DRIFT: xyflow"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/query rev-parse HEAD)" = "46d7f02f1c7b9fcd3255082cc7103e8bfa3dab76" ] || { echo "CHECKOUT DRIFT: query"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/table rev-parse HEAD)" = "d08af367e11c539bb7e18c2472aa761149ef6db6" ] || { echo "CHECKOUT DRIFT: table"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/tldraw rev-parse HEAD)" = "5590d14d8edd4faab7dc1177b6e1adb28876fd23" ] || { echo "CHECKOUT DRIFT: tldraw"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/redux-devtools rev-parse HEAD)" = "f4b4668c30ae08920c59a76cc4629c35c16ef0fa" ] || { echo "CHECKOUT DRIFT: redux-devtools"; exit 1; }
[ "$(git -C /Users/sauravverma/programs/benchmarks/react-ecosystem/router rev-parse HEAD)" = "3dee5b2e9453d01a3172c73426959007b290b3fc" ] || { echo "CHECKOUT DRIFT: router"; exit 1; }

# --- gate 2: this surface's index must be present ---
[ -f "/Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/_indexes/turbovec/index/react-ecosystem.tvim" ] || { echo "MISSING: /Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/_indexes/turbovec/index/react-ecosystem.tvim"; exit 1; }
[ -f "/Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/_indexes/turbovec/index/chunks.jsonl" ] || { echo "MISSING: /Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/_indexes/turbovec/index/chunks.jsonl"; exit 1; }
[ -f "/Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/_indexes/turbovec_mcp/mcp_turbovector.json" ] || { echo "MISSING: /Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/_indexes/turbovec_mcp/mcp_turbovector.json"; exit 1; }

# --- gate 3: never re-attempt an arm that already ran ---
[ -f $ARM/raw_response.json ] && { echo "ALREADY RUN - refusing to re-attempt"; exit 1; }

# --- gate 4: the sandbox must actually be blinding the gold ---
# The file must EXIST before its unreadability means anything. A stale path made this
# check pass because `cat` failed on a missing file, not on a denied one.
[ -f /Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/hard-lifecycle-fires-for-a-branch-that-was-never-shown/golden.json ] || { echo "NO golden.json at /Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/hard-lifecycle-fires-for-a-branch-that-was-never-shown/golden.json - gate 4 cannot prove anything"; exit 1; }
sandbox-exec -f $PROFILE /bin/cat /Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/hard-lifecycle-fires-for-a-branch-that-was-never-shown/golden.json >/dev/null 2>&1 \
  && { echo "SANDBOX LEAK: golden.json is readable"; exit 1; }

mkdir -p $CWD
ST=$(date +%s)
( cd $CWD && sandbox-exec -f $PROFILE "$CLAUDE" -p "$(cat $ARM/run_prompt.txt)" \
    --model claude-opus-5 \
    --setting-sources "" --disable-slash-commands \
    --mcp-config "/Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/_indexes/turbovec_mcp/mcp_turbovector.json" --strict-mcp-config \
    --allowedTools "mcp__turbovector__search" "mcp__turbovector__get_file" "mcp__turbovector__read_lines" "mcp__turbovector__index_info" \
    --disallowedTools Bash Read Write Edit Grep Glob WebFetch WebSearch Task NotebookEdit TodoWrite ReportFindings \
    --max-budget-usd 40 \
    --output-format json < /dev/null ) > $ARM/raw_response.json 2> $ARM/stderr.log
echo "wall_seconds=$(( $(date +%s) - ST ))" > $ARM/wall.txt
echo "arm finished: hard-lifecycle-fires-for-a-branch-that-was-never-shown turbovec $(cat $ARM/wall.txt)"
echo
echo "next: python3 /Users/sauravverma/programs/benchmarks/react-ecosystem/score_arm.py cross-repo/hard-lifecycle-fires-for-a-branch-that-was-never-shown claudecli_opus5_mcp_turbovec"
