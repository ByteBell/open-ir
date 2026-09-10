#!/bin/zsh
# Launch the claudecli_opus5_mcp_turbovec arm for cal.com @ 9d452282 in ONE fresh isolated headless
# session, under a sandbox-exec profile that makes the checkout and the gold set
# unreadable to the whole process tree. The turbovector MCP is the only search surface.
set -e
CASE=~/programs/benchmarks/react-ecosystem/cal.com.processed/9d4522825bc39621a4d6385f7c13643e64142e10
ARM=$CASE/claudecli_opus5_mcp_turbovec
CLAUDE=/Users/sauravverma/.nvm/versions/node/v24.9.0/bin/claude
[ "$(git -C $CASE/repo rev-parse HEAD)" = "9d4522825bc39621a4d6385f7c13643e64142e10" ] || { echo "CHECKOUT MISMATCH"; exit 1; }
[ -f $ARM/raw_response.json ] && { echo "ALREADY RUN - refusing to re-attempt"; exit 1; }

ST=$(date +%s)
sandbox-exec -f $ARM/sandbox.sb \
  "$CLAUDE" -p "$(cat $ARM/run_prompt.txt)" \
    --model claude-opus-5 \
    --mcp-config $ARM/mcp_turbovector.json --strict-mcp-config \
    --allowedTools "mcp__turbovector__search,mcp__turbovector__get_file,mcp__turbovector__read_lines,mcp__turbovector__index_info" --disallowedTools "Bash,Read,Write,Edit,Grep,Glob,WebFetch,WebSearch,Task,NotebookEdit,BashOutput,KillShell" \
    --output-format json < /dev/null > $ARM/raw_response.json 2> $ARM/stderr.log
echo "wall_seconds=$(( $(date +%s) - ST ))" > $ARM/wall.txt
echo "arm finished: $(cat $ARM/wall.txt)"
