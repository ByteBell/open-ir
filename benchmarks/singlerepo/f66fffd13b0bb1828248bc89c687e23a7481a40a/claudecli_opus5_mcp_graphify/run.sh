#!/bin/zsh
# Launch the claudecli_opus5_mcp_graphify arm for cal.com @ f66fffd1 in ONE fresh isolated headless
# session, under a sandbox-exec profile that makes the checkout and the gold set
# unreadable to the whole process tree. The graphify MCP is the only search surface.
set -e
CASE=~/programs/benchmarks/react-ecosystem/cal.com.processed/f66fffd13b0bb1828248bc89c687e23a7481a40a
ARM=$CASE/claudecli_opus5_mcp_graphify
CLAUDE=/Users/sauravverma/.nvm/versions/node/v24.9.0/bin/claude
[ "$(git -C $CASE/repo rev-parse HEAD)" = "f66fffd13b0bb1828248bc89c687e23a7481a40a" ] || { echo "CHECKOUT MISMATCH"; exit 1; }
[ -f $ARM/raw_response.json ] && { echo "ALREADY RUN - refusing to re-attempt"; exit 1; }

ST=$(date +%s)
sandbox-exec -f $ARM/sandbox.sb \
  "$CLAUDE" -p "$(cat $ARM/run_prompt.txt)" \
    --model claude-opus-5 \
    --mcp-config $ARM/mcp_graphify.json --strict-mcp-config \
    --allowedTools "mcp__graphify__query_graph,mcp__graphify__get_node,mcp__graphify__get_neighbors,mcp__graphify__shortest_path,mcp__graphify__get_community,mcp__graphify__god_nodes,mcp__graphify__graph_stats,mcp__graphify__list_prs,mcp__graphify__get_pr_impact" --disallowedTools "Bash,Read,Write,Edit,Grep,Glob,WebFetch,WebSearch,Task,NotebookEdit,BashOutput,KillShell" \
    --output-format json < /dev/null > $ARM/raw_response.json 2> $ARM/stderr.log
echo "wall_seconds=$(( $(date +%s) - ST ))" > $ARM/wall.txt
echo "arm finished: $(cat $ARM/wall.txt)"
