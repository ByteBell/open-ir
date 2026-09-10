#!/usr/bin/env python3
"""ranked.json + commands.log from raw_response.json (opencode --format json).

Copied into each opencode arm folder by build_arm_opencode_runners.py; it reads
raw_response.json from its OWN directory, so the copy in the arm folder is the one
that runs. Kept as a real file rather than a string inside the generator so it can
be tested directly.

Deliberately defensive: opencode's event schema is not pinned by this benchmark and
changes between releases, so nothing here indexes into a fixed shape.

The catch that bites a naive parser: in a JSON event stream the assistant's text is
itself a JSON *string*, so the answer arrives with escaped quotes and does NOT parse
where it sits in the raw bytes. Decode first, scan second - every string value in
every event is unescaped and searched, alongside the raw text (which also covers a
plain `--format default` capture).

The array is then found by scanning for balanced [...] and taking the LAST one
matching the cross-repo answer contract - grab the array PATTERN, not the string
position, because a final message can carry prose on either side of it.

Exits non-zero and explains itself rather than writing a half-formed ranked.json.
"""
import json
import os
import re
import sys

ARM = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ARM, "raw_response.json")
if not os.path.exists(RAW):
    sys.exit(f"no raw_response.json in {ARM} - has the arm run?")
raw = open(RAW, encoding="utf-8", errors="replace").read()


def strings(node, out):
    """Every string anywhere in a decoded event, so escaped text becomes searchable."""
    if isinstance(node, str):
        out.append(node)
    elif isinstance(node, dict):
        for v in node.values():
            strings(v, out)
    elif isinstance(node, list):
        for v in node:
            strings(v, out)


haystacks = [raw]
for line in raw.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        strings(json.loads(line), haystacks)
    except ValueError:
        continue
# A stream emitted as one pretty-printed document rather than JSONL.
try:
    strings(json.loads(raw), haystacks)
except ValueError:
    pass


def arrays(text):
    """Every balanced [...] in the text that parses as JSON, in order."""
    out, dec = [], json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch == "[":
            try:
                out.append(dec.raw_decode(text[i:])[0])
            except ValueError:
                pass
    return out


def is_answer(v):
    return isinstance(v, list) and bool(v) and all(
        isinstance(e, dict) and "repo" in e and "files" in e for e in v)


cands = [v for h in haystacks for v in arrays(h) if is_answer(v)]
if not cands:
    sys.exit("no [{repo, files}] array found in raw_response.json - inspect it by "
             "hand; the run may have errored, hit a limit, or answered in another shape")
ranked = cands[-1]
json.dump(ranked, open(os.path.join(ARM, "ranked.json"), "w"), indent=1)
print(f"ranked.json: {len(ranked)} repo(s), "
      f"{sum(len(e.get('files', [])) for e in ranked)} path(s)")

# commands.log, so score_arm.py's surface check and fold probe have something to read.
# Events are line-delimited, so at most ONE tool name is taken per line: the same call
# usually appears as both "tool" and "name" and would otherwise be counted twice.
TOOL = re.compile(r'"(?:tool|name)"\s*:\s*"(plumbline_[a-z_]+)"')
ARGS = re.compile(r'"(?:input|arguments)"\s*:\s*\{')
lines = []
for line in raw.splitlines():
    m = TOOL.search(line)
    if not m:
        continue
    args, a = "{}", ARGS.search(line)
    if a:
        try:
            args = json.dumps(json.JSONDecoder().raw_decode(line[a.end() - 1:])[0])
        except ValueError:
            pass
    lines.append(f"{len(lines) + 1:02d}. mcp__plumbline__"
                 f"{m.group(1)[len('plumbline_'):]} {args}")
if lines:
    open(os.path.join(ARM, "commands.log"), "w").write("\n".join(lines) + "\n")
    print(f"commands.log: {len(lines)} tool call(s)")
else:
    print("WARNING: no tool calls recovered - score_arm.py will mark the arm "
          "not-comparable for an unverifiable surface. Check raw_response.json.")
