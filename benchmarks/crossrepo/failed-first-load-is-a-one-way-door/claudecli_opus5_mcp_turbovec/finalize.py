#!/usr/bin/env python3
"""Finalize the claudecli_opus5_mcp_turbovec arm: ranked.json, cost.json, result.json.

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

CASE = "xrepo-v6-1-failed-first-load-is-a-one-way-door"
BENCH = "/Users/sauravverma/programs/benchmarks/react-ecosystem"
CDIR = "/Users/sauravverma/programs/benchmarks/react-ecosystem/cross-repo/hard-failed-first-load-is-a-one-way-door"
ARM_NAME = "claudecli_opus5_mcp_turbovec"
ARM = f"{CDIR}/{ARM_NAME}"
CAP = 100

# claude-opus-5 list price, USD per Mtok (same table the sibling arms use)
PRICE = {"input": 5.0, "output": 25.0, "cache_write": 10.0, "cache_read": 0.5}

ROSTER = ["redux", "redux-toolkit", "react-redux", "reselect", "redux-thunk",
          "react", "jotai", "zustand", "db", "xyflow", "query", "table",
          "tldraw", "redux-devtools"]
TURBOVEC_TOOLS = ["search", "get_file", "read_lines", "index_info"]
ALLOWED_TOOLS = {f"mcp__turbovector__{t}" for t in TURBOVEC_TOOLS}
# Tools that cannot retrieve anything from the arena, so calling one is not a
# retrieval-surface violation: ToolSearch only loads MCP tool schemas,
# ReportFindings only formats output, and get_current_config reads Serena's own
# settings. They are counted and recorded separately rather than silently
# folded into the allow-list.
NON_RETRIEVAL_TOOLS = {"ToolSearch", "ReportFindings", "ScheduleWakeup",
                       "mcp__serena__get_current_config"}


def extract_payload(text):
    """Pull (answer, contract, defect_location) out of the final message.

    Accepts the current object form -- {contract, defect_location, answer} -- and
    the legacy bare [{repo, files}] array, so runs recorded before the format
    changed still score instead of silently reading as an empty answer.
    """
    if not text:
        return [], None, None
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M).strip()
    cands = [t]
    cands += [m.group(0) for m in re.finditer(r"\{.*\}", t, flags=re.S)]
    cands += [m.group(0) for m in re.finditer(r"\[.*\]", t, flags=re.S)]
    for c in cands:
        try:
            obj = json.loads(c)
        except Exception:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("answer"), list):
            a = obj["answer"]
            if all(isinstance(x, dict) and "repo" in x and "files" in x for x in a):
                return a, obj.get("contract"), obj.get("defect_location")
        if (isinstance(obj, list) and obj and all(
                isinstance(x, dict) and "repo" in x and "files" in x for x in obj)):
            return obj, None, None
    return [], None, None


def extract(text):
    return extract_payload(text)[0]


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

    answer, contract, defect_location = extract_payload(env.get("result", ""))
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

    disallowed = {k: v for k, v in tools.items()
                  if k not in ALLOWED_TOOLS and k not in NON_RETRIEVAL_TOOLS}
    non_retrieval = {k: v for k, v in tools.items() if k in NON_RETRIEVAL_TOOLS}
    cost = {
        "session_id": sid,
        "arm": ARM_NAME,
        "case": CASE,
        "model": env.get("modelUsage") and list(env["modelUsage"]) or "claude-opus-5",
        "launch": ("fresh isolated `claude -p` under sandbox-exec, "
                   "--setting-sources '' --disable-slash-commands, "
                   "--strict-mcp-config with "
                   "ONLY the shared turbovector MCP server (one vector index built across "
                   "all 14 pinned repos), --allowedTools mcp__turbovector__* and "
                   "--disallowedTools Bash,Read,Write,Edit,Grep,Glob,..."),
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
        "non_retrieval_tool_calls": non_retrieval,
        "mcp_tool_calls": {k: v for k, v in tools.items() if k.startswith("mcp__")},
        "surface_pure": not disallowed,
        "surface_pure_note": (
            "Arm surface is Opus 5 with ONLY the turbovector vector-search MCP "
            "server (search, get_file, read_lines, index_info) against a single "
            "turbovec/TurboQuant index built across all 14 pinned repos. The server "
            "answers every call from the index and its chunk store and never opens a "
            "checkout, so retrieval is embedding similarity end to end. "
            "Bash/Read/Grep/Glob/Write/Edit and every other MCP server are excluded "
            "by --disallowedTools and --strict-mcp-config, so a filesystem-grep "
            "escape was not merely unused but impossible. Any tool outside the "
            "turbovector allow-list counts as a surface violation."),
        "sandbox": {
            "mechanism": "sandbox-exec (macOS seatbelt), profile pinned at sandbox.sb",
            "gold_readable": False,
            "other_arms_readable": False,
            "transcripts_readable": False,
            "out_of_arena_paths_attempted": outside,
            "reads_refused_by_kernel": denied,
            "contamination_possible": False,
            "note": ("The benchmark tree is denied wholesale and only the 14 repo "
                     "directories plus cross-repo/_indexes/turbovec (the "
                     "turbovector MCP server's own vector index) are re-allowed, so "
                     "golden.json, DONOTREADTHISFOLDER/ and every sibling arm's "
                     "results fail with EPERM. ~/.claude/projects is denied too, so "
                     "no earlier session transcript - nor this run's own - is "
                     "readable. cwd was a fresh empty directory, no settings sources were "
                     "loaded and slash commands were disabled, so no CLAUDE.md, "
                     "skills, plugins or hooks applied; auto-memory is unreadable "
                     "under the sandbox."),
        },
        "transcript": tpath,
        "prompt_caching": "default (caching not disabled)",
        "index": {
            "tool": "turbovec (TurboQuant) + sentence-transformers/all-MiniLM-L6-v2",
            "index_location": f"{BENCH}/cross-repo/_indexes/turbovec/index",
            "build": "one cross-repo index: every tracked source file in all 14 pinned "
                     "repos cut into 20-line windows at stride 15, embedded 384-d "
                     "(normalized) and stored in a turbovec IdMapIndex at 4-bit; the "
                     "chunk text is kept in chunks.jsonl so the server never reads a "
                     "checkout (shared across every cross-repo case, built once)",
        },
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
        "contract": contract,
        "defect_location": defect_location,
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
            "surface": ("Opus 5 with ONLY the turbovector MCP server: semantic "
                        "vector search over a single turbovec index built across all "
                        "14 pinned repos. No Bash, Read, Grep, Glob, filesystem "
                        "access, network, or subagents."),
            "repo_pins": pins,
            "checkout_verified": ("run.sh gates on git rev-parse HEAD == pinned commit "
                                  "for all 14 repositories before launch"),
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
