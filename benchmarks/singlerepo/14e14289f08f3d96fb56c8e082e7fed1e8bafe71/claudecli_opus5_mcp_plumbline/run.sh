#!/bin/zsh
# Both phases for this arm, each in its own session.
#   phase 1  retrieval  -> ranked.json, commands.log, output.log, raw_response.json
#   phase 2  scoring    -> result.json, cost.json   (fresh session; it reads the gold)
#
#   ./run.sh            run this arm; refuses if it has already been run
#   ./run.sh --fresh    re-measure: copies the prompt into the next free <arm>_vN
#                       and runs that, leaving the existing answer untouched
set -e
ROOT=${0:A:h}/../../..
CASE="cal.com.processed/14e14289f08f3d96fb56c8e082e7fed1e8bafe71"
ARM="claudecli_opus5_mcp_plumbline"
cd $ROOT
echo "=== phase 1: retrieval — $ARM ==="
./run_plumbline_arm.sh "$CASE" "$ARM" "$@"
# --fresh may have redirected into a new arm dir; score the one that actually ran.
[ -f "$CASE/.last_arm" ] && ARM=$(cat "$CASE/.last_arm")
echo
echo "=== phase 2: scoring — $ARM ==="
./run_stage2.sh "$CASE" "$ARM"
