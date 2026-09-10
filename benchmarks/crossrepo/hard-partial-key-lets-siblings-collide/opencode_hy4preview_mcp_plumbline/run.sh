#!/bin/zsh
# opencode_hy4preview_mcp_plumbline — hard-partial-key-lets-siblings-collide
# a remote knowledge-graph MCP; the checkouts are NOT readable at all.
# Same surface and the SAME run_prompt.txt as claudecli_opus5_mcp_plumbline; the
# harness and the model are the only things that differ, which is what makes the
# pair a measurement rather than two unrelated runs.
#
# Surface gate is two-layer, because opencode has no --allowedTools:
#   kernel  — sandbox.sb denies the whole benchmark tree with no re-open, so the
#             checkouts AND golden.json are unreadable (gates 4 and 5 prove it);
#   agent   — opencode.json turns every builtin tool off and re-enables plumbline*.
#
#   PREFLIGHT=1 ./run.sh   runs every gate and the model check, then exits without
#                          launching. Costs nothing. Do this before a real run.
set -e
ARM=~/programs/benchmarks/react-ecosystem/cross-repo/hard-partial-key-lets-siblings-collide/opencode_hy4preview_mcp_plumbline
CWD=/tmp/xrepo-runs/hard-partial-key-lets-siblings-collide-plumbline-opencode
PROFILE=$ARM/sandbox.sb
OPENCODE=${OPENCODE:-/Users/sauravverma/.opencode/bin/opencode}
MODEL=${MODEL:-openrouter/tencent/hy4-preview}
AGENT=plumbline-arm

# --- gate 1: every checkout on its pinned commit ---
[ "$(git -C ~/programs/benchmarks/react-ecosystem/redux rev-parse HEAD)" = "3aa561f9fc13f3287e6d83764f85fe0e82437c5f" ] || { echo "CHECKOUT DRIFT: redux"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/redux-toolkit rev-parse HEAD)" = "b1c5130154c454ca8387f55da6122fcb507c560c" ] || { echo "CHECKOUT DRIFT: redux-toolkit"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/react-redux rev-parse HEAD)" = "ad5d1e0816d0cb1464b25cf2853f2a7d73433f5b" ] || { echo "CHECKOUT DRIFT: react-redux"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/reselect rev-parse HEAD)" = "8d87c27b75f55883629be75d1eae1c27832d907a" ] || { echo "CHECKOUT DRIFT: reselect"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/redux-thunk rev-parse HEAD)" = "184205d49f707c6f203269e0d39ad85824801816" ] || { echo "CHECKOUT DRIFT: redux-thunk"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/react rev-parse HEAD)" = "3a717e42438afac81020cdec297dadb5613a4304" ] || { echo "CHECKOUT DRIFT: react"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/jotai rev-parse HEAD)" = "5c4ca26b0db5571114be58393e17854a771f7790" ] || { echo "CHECKOUT DRIFT: jotai"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/zustand rev-parse HEAD)" = "beca84e600e4e250f6b244d22878e72948f331c7" ] || { echo "CHECKOUT DRIFT: zustand"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/db rev-parse HEAD)" = "7f0fa36ff6d48b0494ed5f6a1223fd18c317e41f" ] || { echo "CHECKOUT DRIFT: db"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/xyflow rev-parse HEAD)" = "360f5b13e2bc6899ea06b4be1a49b068d86926cf" ] || { echo "CHECKOUT DRIFT: xyflow"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/query rev-parse HEAD)" = "46d7f02f1c7b9fcd3255082cc7103e8bfa3dab76" ] || { echo "CHECKOUT DRIFT: query"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/table rev-parse HEAD)" = "d08af367e11c539bb7e18c2472aa761149ef6db6" ] || { echo "CHECKOUT DRIFT: table"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/tldraw rev-parse HEAD)" = "5590d14d8edd4faab7dc1177b6e1adb28876fd23" ] || { echo "CHECKOUT DRIFT: tldraw"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/redux-devtools rev-parse HEAD)" = "f4b4668c30ae08920c59a76cc4629c35c16ef0fa" ] || { echo "CHECKOUT DRIFT: redux-devtools"; exit 1; }
[ "$(git -C ~/programs/benchmarks/react-ecosystem/router rev-parse HEAD)" = "3dee5b2e9453d01a3172c73426959007b290b3fc" ] || { echo "CHECKOUT DRIFT: router"; exit 1; }

# --- gate 2: this surface's index must be present ---
[ -f "~/programs/benchmarks/react-ecosystem/mcp_plumbline.json" ] || { echo "MISSING: ~/programs/benchmarks/react-ecosystem/mcp_plumbline.json"; exit 1; }

# --- gate 3: never re-attempt an arm that already ran ---
for f in raw_response.json ranked.json result.json; do
  [ -f "$ARM/$f" ] && { echo "ALREADY RUN ($f present) - refusing to re-attempt"; exit 1; }
done

# --- gate 4: the sandbox must actually be blinding the gold ---
# The file must EXIST before its unreadability means anything: a stale path makes
# `cat` fail because the file is missing, not because it was denied.
[ -f ~/programs/benchmarks/react-ecosystem/cross-repo/hard-partial-key-lets-siblings-collide/golden.json ] || { echo "NO golden.json at ~/programs/benchmarks/react-ecosystem/cross-repo/hard-partial-key-lets-siblings-collide/golden.json - gate 4 cannot prove anything"; exit 1; }
sandbox-exec -f $PROFILE /bin/cat ~/programs/benchmarks/react-ecosystem/cross-repo/hard-partial-key-lets-siblings-collide/golden.json >/dev/null 2>&1 \
  && { echo "SANDBOX LEAK: golden.json is readable"; exit 1; }

# --- gate 5: and the checkouts too - this arm must not be able to read a repo ---
# plumbline is a remote graph: an answer that could have come off disk is void.
for R in redux redux-toolkit react-redux reselect redux-thunk react jotai zustand db xyflow query table tldraw redux-devtools router; do
  sandbox-exec -f $PROFILE /bin/ls ~/programs/benchmarks/react-ecosystem/$R >/dev/null 2>&1 \
    && { echo "SANDBOX LEAK: checkout $R is readable"; exit 1; }
done

# --- gate 6: the model must actually exist in this opencode install ---
# `opencode/tencent/hy4-preview` appears in older cal.com artifacts and does NOT
# resolve; without this gate that typo launches and fails mid-run.
"$OPENCODE" models 2>/dev/null | grep -qx "$MODEL" \
  || { echo "NO SUCH MODEL: $MODEL (see: opencode models)"; exit 1; }

# --- live config: real token, written OUTSIDE the benchmark tree ---
# The sandbox denies ~/programs/benchmarks/react-ecosystem wholesale, so opencode could not read a config kept
# in the arm folder. The arm's own opencode.json is the redacted record.
mkdir -p $CWD
python3 - "$ARM/opencode.json" "~/programs/benchmarks/react-ecosystem/mcp_plumbline.json" "$CWD/opencode.json" <<'PY'
import json, sys
tmpl, live_src, out = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(tmpl))
cfg["mcp"]["plumbline"]["url"] = json.load(open(live_src))["mcpServers"]["plumbline"]["url"]
json.dump(cfg, open(out, "w"), indent=2)
PY

if [ -n "$PREFLIGHT" ]; then
  echo "PREFLIGHT OK: hard-partial-key-lets-siblings-collide / opencode_hy4preview_mcp_plumbline"
  echo "  gates 1-6 passed, live config at $CWD/opencode.json"
  echo "  launch with: ./run.sh"
  exit 0
fi

ST=$(date +%s)
( cd $CWD && OPENCODE_CONFIG=$CWD/opencode.json \
    sandbox-exec -f $PROFILE "$OPENCODE" run \
      --pure --agent "$AGENT" -m "$MODEL" \
      --dir $CWD --format json \
      "$(cat $ARM/run_prompt.txt)" < /dev/null ) > $ARM/raw_response.json 2> $ARM/stderr.log
echo "wall_seconds=$(( $(date +%s) - ST ))" > $ARM/wall.txt
echo "arm finished: hard-partial-key-lets-siblings-collide opencode_hy4preview_mcp_plumbline $(cat $ARM/wall.txt)"

# opencode writes no cost envelope; `opencode stats` is the only source.
"$OPENCODE" stats > $ARM/stats.txt 2>/dev/null || true

python3 $ARM/extract_ranked.py
echo
echo "next: python3 ~/programs/benchmarks/react-ecosystem/score_arm.py cross-repo/hard-partial-key-lets-siblings-collide opencode_hy4preview_mcp_plumbline"
