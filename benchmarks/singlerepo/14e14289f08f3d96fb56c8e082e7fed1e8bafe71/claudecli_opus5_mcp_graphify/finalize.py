#!/usr/bin/env python3
"""Finalize one retrieval arm: ranked.json, cost.json, result.json.

Usage: finalize.py <case_dir> <arm_name> <surface_description>

GOLD-BLIND BY CONSTRUCTION. gold.json is read here and its paths are written to
result.json on disk, but NOTHING derived from gold is ever printed. stdout carries
aggregate metrics only, so running this cannot contaminate an agent's context for
this case. Do not add a print of hits/missed_gold/ranked_detail.
"""
import collections
import glob
import json
import os
import re
import sys

CASE = os.path.abspath(sys.argv[1])
ARM_NAME = sys.argv[2]
SURFACE = sys.argv[3]
ARM = f"{CASE}/{ARM_NAME}"
INDEX_AT = os.path.basename(CASE)
CAP = 40

# claude-opus-5[1m] list price, USD per Mtok (same table the sibling arms used)
PRICE = {"input": 5.0, "output": 25.0, "cache_write": 10.0, "cache_read": 0.5}


def extract_paths(text):
    """Pull the ranked array out of the final message, tolerating fences/prose."""
    if not text:
        return []
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M).strip()
    # Preferred: the documented envelope with an "answer" array.
    for cand in [t] + [m.group(0) for m in re.finditer(r"\{.*\}", t, flags=re.S)]:
        try:
            obj = json.loads(cand)
        except Exception:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("answer"), list):
            return [x for x in obj["answer"] if isinstance(x, str)]
    # Fallback: a bare array of paths.
    for cand in [t] + [m.group(0) for m in re.finditer(r"\[.*?\]", t, flags=re.S)]:
        try:
            obj = json.loads(cand)
        except Exception:
            continue
        if isinstance(obj, list) and obj and all(isinstance(x, str) for x in obj):
            return obj
    # Last resort: the envelope is malformed somewhere (an unescaped quote in the
    # prose fields is the usual culprit), but the "answer" array itself is intact.
    # Bracket-scan from the "answer" key and parse just that slice. Note the paths
    # themselves contain [ ] (Next.js route segments like [user]), so a non-greedy
    # regex cannot be used here - the scan must respect string context.
    i = t.find('"answer"')
    if i != -1:
        j = t.find("[", i)
        if j != -1:
            depth, k, instr, esc = 0, j, False, False
            while k < len(t):
                ch = t[k]
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    instr = not instr
                elif not instr:
                    if ch == "[":
                        depth += 1
                    elif ch == "]":
                        depth -= 1
                        if depth == 0:
                            try:
                                obj = json.loads(t[j:k + 1])
                            except Exception:
                                break
                            if isinstance(obj, list):
                                return [x for x in obj if isinstance(x, str)]
                            break
                k += 1
    return []


def transcript(session_id):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session_id}.jsonl"))
    return hits[0] if hits else None


def audit(session_id):
    """Tool histogram + MCP result tokens, proving the arm used only its own surface."""
    p = transcript(session_id)
    if not p:
        return {}, 0, None
    calls, ids = collections.Counter(), {}
    mcp_chars = 0
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
                elif b.get("type") == "tool_result":
                    name = ids.get(b.get("tool_use_id"), "")
                    if name.startswith("mcp__"):
                        c = b.get("content")
                        mcp_chars += len(c if isinstance(c, str) else json.dumps(c))
    return dict(calls), mcp_chars // 4, p


def commands_log(session_id, out_path):
    """Replay every tool call the arm made, in order, as the arm's commands.log."""
    p = transcript(session_id)
    if not p:
        return
    n = 0
    with open(p) as f, open(out_path, "w") as w:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            for b in (d.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    n += 1
                    w.write(f"{n:02d}. {b['name']} {json.dumps(b.get('input', {}))}\n")


def prf(ranked, gset, k=None):
    """Precision / recall / F1 over the top-k of the ranked list (k=None -> full list)."""
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

    ranked = extract_paths(env.get("result", ""))[:CAP]
    if not ranked:
        print("NO RANKED LIST EXTRACTED - not scoring")
        return 1
    json.dump(ranked, open(f"{ARM}/ranked.json", "w"), indent=1)

    sid = env.get("session_id")
    u = env.get("usage", {}) or {}
    tok = {
        "input": u.get("input_tokens", 0),
        "output": u.get("output_tokens", 0),
        "cache_creation": u.get("cache_creation_input_tokens", 0),
        "cache_read": u.get("cache_read_input_tokens", 0),
    }
    list_usd = round(
        (tok["input"] * PRICE["input"] + tok["output"] * PRICE["output"]
         + tok["cache_creation"] * PRICE["cache_write"]
         + tok["cache_read"] * PRICE["cache_read"]) / 1e6, 6)
    tools, mcp_tokens, tpath = audit(sid)
    commands_log(sid, f"{ARM}/commands.log")
    wall = None
    if os.path.exists(f"{ARM}/wall.txt"):
        wall = int(open(f"{ARM}/wall.txt").read().strip().split("=")[1])

    # ToolSearch is the deferred-tool SCHEMA loader, not a retrieval surface: a
    # `select:` query returns tool_reference stubs and cannot read the repo. It is
    # how this CLI build makes the MCP tools callable at all, so counting it as a
    # surface violation would void every arm. Every other non-MCP tool still
    # counts against purity.
    SCHEMA_LOADERS = {"ToolSearch"}
    nonmcp = {k: v for k, v in tools.items()
              if not k.startswith("mcp__") and k not in SCHEMA_LOADERS}
    schema_loads = {k: v for k, v in tools.items() if k in SCHEMA_LOADERS}
    cost = {
        "session_id": sid,
        "arm": ARM_NAME,
        "model": env.get("modelUsage") and list(env["modelUsage"]) or "claude-opus-5",
        "launch": ("fresh isolated `claude -p` under sandbox-exec, "
                   "--strict-mcp-config"),
        "price_per_mtok_usd": PRICE,
        "usd_per_query_cli": env.get("total_cost_usd"),
        "usd_per_query_list_price": list_usd,
        "duration_ms": env.get("duration_ms"),
        "wall_seconds": wall,
        "num_turns": env.get("num_turns"),
        "tokens": tok,
        "tokens_retrieved": mcp_tokens,
        "cache_clean": tok["cache_read"] == 0 and tok["cache_creation"] == 0,
        "cache_mode": "cold" if (tok["cache_read"] == 0 and tok["cache_creation"] == 0) else "warm",
        "tool_calls": tools,
        "non_mcp_tool_calls": nonmcp,
        "schema_loader_calls": schema_loads,
        "surface_pure": not nonmcp,
        "surface_pure_note": (
            "ToolSearch excluded from the purity test: it loads MCP tool SCHEMAS "
            "(select: -> tool_reference stubs) and has no read access to the "
            "checkout. All repo evidence came from this arm's own MCP tools."),
        "transcript": tpath,
        "prompt_caching": "default (caching not disabled)",
    }
    json.dump(cost, open(f"{ARM}/cost.json", "w"), indent=1)

    # ---- scoring (gold read here; never printed) ----
    g = json.load(open(f"{CASE}/gold.json"))
    gold = list(g["gold"])
    gset = set(gold)
    hits = [p for p in ranked if p in gset]
    detail = [{"rank": i + 1, "path": p, "gold": p in gset} for i, p in enumerate(ranked)]
    first = next((i + 1 for i, p in enumerate(ranked) if p in gset), None)

    def rec(k):
        return round(len(set(ranked[:k]) & gset) / len(gset), 4) if gset else None

    metrics = {
        "recall@10": rec(10), "recall@20": rec(20), "recall@40": rec(40),
        "precision@5": round(len(set(ranked[:5]) & gset) / min(5, len(ranked)), 4) if ranked else 0.0,
        "precision@20": round(len(set(ranked[:20]) & gset) / min(20, len(ranked)), 4) if ranked else 0.0,
        "MRR": round(1 / first, 4) if first else 0.0,
        "first_hit_rank": first,
        "hits_at_20": f"{len(set(ranked[:20]) & gset)}/{len(gset)}",
    }
    prf_block = {
        "full_list": prf(ranked, gset),
        "@5": prf(ranked, gset, 5),
        "@10": prf(ranked, gset, 10),
        "@20": prf(ranked, gset, 20),
    }
    result = {
        "arm": ARM_NAME,
        "case_id": g["id"],
        "index_at": INDEX_AT,
        "retrieved": len(ranked),
        "gold_counts": g.get("counts"),
        "gold_schema": g.get("gold_policy"),
        "metrics": metrics,
        "prf": prf_block,
        "hits": hits,
        "ranked_detail": detail,
        "missed_gold": [p for p in gold if p not in set(ranked)],
        "retriever": {
            "surface": SURFACE,
            "surface_pure": cost["surface_pure"],
        },
        "cost": cost,
        "comparable": bool(cost["surface_pure"]),
    }
    if not result["comparable"]:
        result["not_comparable_reason"] = (
            (f"non-MCP tools used: {nonmcp}" if nonmcp else "")).strip("; ")
    json.dump(result, open(f"{ARM}/result.json", "w"), indent=1)

    print(json.dumps({
        "arm": ARM_NAME, "case": INDEX_AT[:12], "retrieved": len(ranked),
        "gold_size": len(gset), "metrics": metrics, "prf": prf_block,
        "usd_cli": cost["usd_per_query_cli"], "usd_list": list_usd, "wall_s": wall,
        "turns": cost["num_turns"], "tokens": tok, "tokens_retrieved": mcp_tokens,
        "cache_clean": cost["cache_clean"], "surface_pure": cost["surface_pure"],
        "tool_calls": tools, "comparable": result["comparable"],
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
