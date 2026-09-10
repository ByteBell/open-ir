#!/bin/bash
# xrepo-v6-5 :: arm claudecli_opus5_mcp_plumbline
# Fresh isolated `claude -p` under sandbox-exec. Surface = plumbline MCP + Bash only.
set -uo pipefail
cd /tmp

ARM="/Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/hard-delete-is-not-terminal-and-its-cascade-is-not-scoped/claudecli_opus5_mcp_plumbline"
MCP="/Users/sauravverma/programs/benchmarks/react-ecosystem/mcp_plumbline.json"

PL=$(printf 'mcp__plumbline__%s,' blueprint case_file case_notes cold_case collateral_damage \
  cross_repo_lookup dragnet evidence_locker file_a_complaint interrogation kingpin manhunt \
  mugshot paper_trail pull_the_evidence read_the_fine_print roll_call shakedown stakeout the_receipts)
TOOLS="Bash,ToolSearch,${PL%,}"

START=$(date +%s)
DISABLE_PROMPT_CACHING=1 sandbox-exec -f "$ARM/sandbox.sb" \
  claude -p "$(cat "$ARM/run_prompt.txt")" \
    --model claude-opus-5 \
    --output-format json \
    --setting-sources '' \
    --disable-slash-commands \
    --strict-mcp-config --mcp-config "$MCP" \
    --allowedTools "$TOOLS" \
    --disallowedTools "Read,Write,Edit,MultiEdit,NotebookEdit,Grep,Glob,WebFetch,WebSearch,Task,Agent,TodoWrite" \
    --max-turns 120 \
    > "$ARM/raw_response.json" 2> "$ARM/stderr.log"
RC=$?
echo "$(( $(date +%s) - START ))s" > "$ARM/wall.txt"
echo "exit=$RC wall=$(cat "$ARM/wall.txt")"
