#!/usr/bin/env python3
"""Finalize the claudecli_opus5_bare arm: ranked.json, cost.json, result.json.

GOLD-BLIND BY CONSTRUCTION. golden.json is read here and its paths are written to
result.json on disk, but NOTHING derived from gold is ever printed. stdout carries
aggregate metrics only, so running this cannot contaminate an agent's context for
this case. Do not add a print of hits/missed_gold/ranked_detail.
"""
import collections
import glob
import json
import os
import re
import subprocess
import sys

CASE = "hard-the-virtual-container-is-not-a-node"
BENCH = "/Users/sauravverma/programs/benchmarks/react-ecosystem"
CDIR = f"{BENCH}/cross-repo/{CASE}"
ARM_NAME = "claudecli_opus5_mcp_graphify"
ARM = f"{CDIR}/{ARM_NAME}"
import sys as _sys
_sys.path.insert(0, "/Users/sauravverma/programs/benchmarks/react-ecosystem")
from bench_config import RANKED_LIST_CAP
# Was hardcoded 100 while score_arm.py truncated at 50. One source of truth now.
CAP = RANKED_LIST_CAP

# claude-opus-5[1m] list price, USD per Mtok (same table the sibling arms used)
PRICE = {"input": 5.0, "output": 25.0, "cache_write": 10.0, "cache_read": 0.5}

ROSTER = ["redux", "redux-toolkit", "react-redux", "reselect", "redux-thunk",
          "react", "jotai", "zustand", "db", "xyflow", "query", "table",
          "tldraw", "redux-devtools", "router"]
ALLOWED_TOOLS = {f"mcp__graphify__{t}" for t in
                 ("query_graph", "get_node", "get_neighbors", "get_community",
                  "god_nodes", "graph_stats", "shortest_path")} | {"ToolSearch"}


def _bracket_spans(t):
    r"""Every balanced [...] region that starts a list of objects, longest first.

    The naive r"\[.*\]" used elsewhere anchors on the FIRST '[' in the text, which
    in a prose-then-JSON answer is often something like `Entry[]` inside a sentence,
    so the greedy match spans from that to the final ']' and never parses.
    """
    spans = []
    for i, ch in enumerate(t):
        if ch != "[":
            continue
        j = i + 1
        while j < len(t) and t[j].isspace():
            j += 1
        if j >= len(t) or t[j] != "{":
            continue
        depth, k, instr, esc = 0, i, False, False
        while k < len(t):
            c = t[k]
            if instr:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    instr = False
            elif c == '"':
                instr = True
            elif c in "[{":
                depth += 1
            elif c in "]}":
                depth -= 1
                if depth == 0:
                    spans.append(t[i:k + 1])
                    break
            k += 1
    return sorted(spans, key=len, reverse=True)


def extract(text):
    if not text:
        return []
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M).strip()
    for c in [t] + _bracket_spans(t):
        try:
            obj = json.loads(c)
        except Exception:
            continue
        if isinstance(obj, list) and obj and all(
                isinstance(x, dict) and "repo" in x and "files" in x for x in obj):
            return obj
    return []


def flatten(answer):
    """Ranked list of 'repo::path', in the order the model presented them."""
    out = []
    for blk in answer:
        r = blk.get("repo")
        for f in blk.get("files") or []:
            key = f"{r}::{f}"
            if key not in out:
                out.append(key)
    return out


def exists_at_pin(pins, key):
    repo, path = key.split("::", 1)
    if repo not in pins:
        return False
    rc = subprocess.run(["git", "-C", f"{BENCH}/{repo}", "cat-file", "-e",
                         f"{pins[repo]}:{path}"], capture_output=True).returncode
    return rc == 0


def transcript(session_id):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session_id}.jsonl"))
    return hits[0] if hits else None


def audit(session_id):
    """Tool histogram, bytes read back, and any attempt to leave the 14 repos."""
    p = transcript(session_id)
    if not p:
        return {}, 0, None, {}, 0
    calls, ids = collections.Counter(), {}
    chars = 0
    outside = collections.Counter()
    denied = 0
    with open(p) as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            for b in (d.get("message") or {}).get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    calls[b["name"]] += 1
                    ids[b["id"]] = b["name"]
                    blob = json.dumps(b.get("input") or {})
                    # Classify by the first path segment under the benchmark root.
                    # A bare root (`ls <root>/`) is a directory probe, not a read of
                    # anything in particular; a named segment outside the roster is
                    # a genuine reach for out-of-arena material. Either way the
                    # kernel refuses it - this only measures what was ATTEMPTED.
                    for m in re.finditer(re.escape(BENCH) + r"/([\w.\-]*)", blob):
                        seg = m.group(1)
                        if not seg:
                            outside["<benchmark-root-listing>"] += 1
                        elif seg not in ROSTER:
                            outside[seg] += 1
                elif b.get("type") == "tool_result":
                    c = b.get("content")
                    txt = c if isinstance(c, str) else json.dumps(c)
                    chars += len(txt)
                    denied += txt.count("Operation not permitted")
    return dict(calls), chars // 4, p, dict(outside), denied


def prf(ranked, gset, k=None):
    cut = ranked if k is None else ranked[:k]
    if not cut or not gset:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "hits": 0,
                "retrieved": len(cut), "gold_size": len(gset)}
    hits = len(set(cut) & gset)
    p = hits / len(cut)
    r = hits / len(gset)
    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f1, 4),
            "hits": hits, "retrieved": len(cut), "gold_size": len(gset)}


def main():
    env = json.load(open(f"{ARM}/raw_response.json"))
    if env.get("is_error") or env.get("subtype") not in (None, "success"):
        print(f"RUN ERRORED: subtype={env.get('subtype')} - not scoring")
        return 1

    g = json.load(open(f"{CDIR}/golden.json"))
    pins = {r: c for r, c in
            (l.split() for l in open(f"{ARM}/run_prompt.txt")
             if l.startswith("  ") and len(l.split()) == 2
             and len(l.split()[1]) == 40)}

    answer = extract(env.get("result", ""))
    ranked = flatten(answer)[:CAP]
    json.dump(answer, open(f"{ARM}/ranked.json", "w"), indent=1)

    sid = env.get("session_id")
    u = env.get("usage", {}) or {}
    tok = {"input": u.get("input_tokens", 0),
           "output": u.get("output_tokens", 0),
           "cache_creation": u.get("cache_creation_input_tokens", 0),
           "cache_read": u.get("cache_read_input_tokens", 0)}
    list_usd = round((tok["input"] * PRICE["input"] + tok["output"] * PRICE["output"]
                      + tok["cache_creation"] * PRICE["cache_write"]
                      + tok["cache_read"] * PRICE["cache_read"]) / 1e6, 6)
    tools, read_tokens, tpath, outside, denied = audit(sid)
    wall = None
    if os.path.exists(f"{ARM}/wall.txt"):
        wall = int(open(f"{ARM}/wall.txt").read().strip().split("=")[1])

    disallowed = {k: v for k, v in tools.items() if k not in ALLOWED_TOOLS}
    cost = {
        "session_id": sid,
        "arm": ARM_NAME,
        "case": CASE,
        "model": env.get("modelUsage") and list(env["modelUsage"]) or "claude-opus-5",
        "launch": ("fresh isolated `claude -p` under sandbox-exec, "
                   "--setting-sources \"\" --disable-slash-commands, "
                   "--strict-mcp-config with ONLY the graphify MCP server (one merged "
                   "AST graph over all 15 pinned repos, 240420 nodes / 447505 edges), "
                   "--allowedTools mcp__graphify__* and Bash/Read/Write/Edit/Grep/Glob "
                   "explicitly disallowed. Prompt caching left ENABLED."),
        "price_per_mtok_usd": PRICE,
        "usd_per_query_cli": env.get("total_cost_usd"),
        "usd_per_query_list_price": list_usd,
        "duration_ms": env.get("duration_ms"),
        "wall_seconds": wall,
        "num_turns": env.get("num_turns"),
        "tokens": tok,
        "tokens_retrieved": read_tokens,
        "cache_clean": tok["cache_read"] == 0 and tok["cache_creation"] == 0,
        "cache_mode": "cold" if (tok["cache_read"] == 0 and tok["cache_creation"] == 0) else "warm",
        "tool_calls": tools,
        "disallowed_tool_calls": disallowed,
        "mcp_tool_calls": {k: v for k, v in tools.items() if k.startswith("mcp__")},
        "surface_pure": not disallowed,
        "surface_pure_note": (
            "Arm surface is the graphify knowledge-graph MCP server alone. The "
            "checkouts are denied at the kernel level, so a filesystem read is not "
            "merely unused but impossible; ToolSearch is exempt because it only loads "
            "MCP tool schemas and cannot read the checkout. Any Bash/Read/Grep/Glob "
            "call counts as a surface violation."),
        "sandbox": {
            "mechanism": "sandbox-exec (macOS seatbelt), profile pinned at sandbox.sb",
            "gold_readable": False,
            "other_arms_readable": False,
            "transcripts_readable": False,
            "out_of_arena_paths_attempted": outside,
            "reads_refused_by_kernel": denied,
            "contamination_possible": False,
            "note": ("The benchmark tree is denied wholesale and only the graphify "
                     "merged graph and its MCP config are re-opened, so golden.json, "
                     "every pinned checkout and every sibling arm's results fail with "
                     "EPERM. The arm can only see what the graph serves. "
                     "~/.claude/projects is denied too, so no "
                     "earlier session transcript - nor this run's own - is readable. "
                     "cwd was a fresh empty directory and --setting-sources \"\" dropped "
                     "CLAUDE.md, skills, plugins, hooks and auto-memory. "
                     "out_of_arena_paths_attempted records what the run REACHED "
                     "for outside the fifteen repos; every such open failed with "
                     "EPERM, so an attempt cost the run a turn and returned no "
                     "content. It is not grounds for excluding the run."),
        },
        "transcript": tpath,
        "prompt_caching": "default (caching not disabled)",
    }
    json.dump(cost, open(f"{ARM}/cost.json", "w"), indent=1)

    # ---- scoring (gold read here; never printed) ----
    gold = [f"{e['repo']}::{f}" for e in g["expected"] for f in e["files"]]
    gset = set(gold)
    gold_repos = {e["repo"] for e in g["expected"]}
    named_repos = {k.split("::", 1)[0] for k in ranked}
    hits = [k for k in ranked if k in gset]
    invalid = [k for k in ranked if not exists_at_pin(pins, k)]
    detail = [{"rank": i + 1, "repo": k.split("::", 1)[0],
               "path": k.split("::", 1)[1], "gold": k in gset,
               "exists_at_pin": k not in invalid} for i, k in enumerate(ranked)]
    first = next((i + 1 for i, k in enumerate(ranked) if k in gset), None)

    def rec(k):
        return round(len(set(ranked[:k]) & gset) / len(gset), 4) if gset else None

    metrics = {
        "recall@10": rec(10), "recall@25": rec(25), "recall@50": rec(50),
        "recall@100": rec(100),
        "precision@5": round(len(set(ranked[:5]) & gset) / min(5, len(ranked)), 4) if ranked else 0.0,
        "precision@10": round(len(set(ranked[:10]) & gset) / min(10, len(ranked)), 4) if ranked else 0.0,
        "MRR": round(1 / first, 4) if first else 0.0,
        "first_hit_rank": first,
        "hits_at_25": f"{len(set(ranked[:25]) & gset)}/{len(gset)}",
        "repo_recall": round(len(gold_repos & named_repos) / len(gold_repos), 4),
        "repos_found": f"{len(gold_repos & named_repos)}/{len(gold_repos)}",
        "repos_named": len(named_repos),
        "invalid_path_rate": round(len(invalid) / len(ranked), 4) if ranked else 0.0,
        "cap_at_run_time": CAP,
    }
    prf_block = {"full_list": prf(ranked, gset), "@10": prf(ranked, gset, 10),
                 "@25": prf(ranked, gset, 25), "@50": prf(ranked, gset, 50),
                 "@100": prf(ranked, gset, 100)}
    result = {
        "arm": ARM_NAME,
        "case_id": g["id"],
        "case_question": g["question"],
        "retrieved": len(ranked),
        "gold_counts": g.get("counts"),
        "gold_size": len(gset),
        "gold_repo_count": len(gold_repos),
        "metrics": metrics,
        "prf": prf_block,
        "hits": hits,
        "ranked_detail": detail,
        "invalid_paths": invalid,
        "missed_gold": [k for k in gold if k not in set(ranked)],
        "retriever": {
            "surface": ("Opus 5 with ONLY the graphify knowledge-graph MCP server: a "
                        "single AST-extracted graph merged across all 15 pinned repos. "
                        "No Bash, Read, Grep, Glob, filesystem access, network, or "
                        "subagents."),
            "repo_pins": pins,
            "checkout_verified": ("run.sh gates on git rev-parse HEAD == pinned commit "
                                  "for all 15 repositories before launch"),
            "isolation": ("kernel-enforced by sandbox-exec: gold, the answer vault and "
                          "every sibling arm are unreadable; no prior-run transcript is "
                          "readable; fresh cwd; no settings sources loaded"),
            "surface_pure": cost["surface_pure"],
        },
        "cost": cost,
        "comparable": bool(cost["surface_pure"]),
    }
    if not result["comparable"]:
        result["not_comparable_reason"] = "; ".join(filter(None, [
            "" if cost["cache_clean"] else "cache not cold",
            f"disallowed tools used: {disallowed}" if disallowed else ""]))
    json.dump(result, open(f"{ARM}/result.json", "w"), indent=1)

    print(json.dumps({
        "case": CASE, "arm": ARM_NAME, "retrieved": len(ranked),
        "gold_size": len(gset), "metrics": metrics, "prf": prf_block,
        "usd_cli": cost["usd_per_query_cli"], "usd_list": list_usd,
        "wall_s": wall, "turns": cost["num_turns"], "tokens": tok,
        "tokens_read": read_tokens, "cache_clean": cost["cache_clean"],
        "surface_pure": cost["surface_pure"], "tool_calls": tools,
        "out_of_arena_attempts": outside, "reads_refused_by_kernel": denied,
        "comparable": result["comparable"],
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
