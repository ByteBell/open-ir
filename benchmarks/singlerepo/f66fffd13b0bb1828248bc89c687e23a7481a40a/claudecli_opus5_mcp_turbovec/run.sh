#!/bin/zsh
# Launch the claudecli_opus5_mcp_turbovec arm for cal.com @ f66fffd1 in ONE fresh isolated headless
# session, under a sandbox-exec profile that makes the checkout and the gold set
# unreadable to the whole process tree. The turbovector MCP is the only search surface.
set -e
CASE=~/programs/benchmarks/react-ecosystem/cal.com.processed/f66fffd13b0bb1828248bc89c687e23a7481a40a
ARM=$CASE/claudecli_opus5_mcp_turbovec
CLAUDE=/Users/sauravverma/.nvm/versions/node/v24.9.0/bin/claude
[ "$(git -C $CASE/repo rev-parse HEAD)" = "f66fffd13b0bb1828248bc89c687e23a7481a40a" ] || { echo "CHECKOUT MISMATCH"; exit 1; }
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
