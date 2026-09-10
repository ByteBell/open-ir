#!/usr/bin/env python3
"""Score this run's ranked.json against the held-out gold set."""
import json, os, sys

CASE = "~/programs/benchmarks/react-ecosystem/cal.com.processed/f66fffd13b0bb1828248bc89c687e23a7481a40a"
ARM  = os.path.dirname(os.path.abspath(__file__))
OUT  = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ARM, "result.json")

gold_doc = json.load(open(os.path.join(CASE, "gold.json")))
gold = gold_doc["gold"]
gold_set = set(gold)
ranked = json.load(open(os.path.join(ARM, "ranked.json")))

def recall_at(k): return len(gold_set & set(ranked[:k])) / len(gold_set)
def precision_at(k): return 0.0 if k == 0 else len(gold_set & set(ranked[:k])) / k
def f1(p, r): return 0.0 if (p + r) == 0 else 2 * p * r / (p + r)

n = len(ranked)
hit_ranks = [i + 1 for i, p in enumerate(ranked) if p in gold_set]
first_hit = hit_ranks[0] if hit_ranks else None
r_full, p_full = recall_at(n), precision_at(n)
r20, p20 = recall_at(20), precision_at(20)

metrics = {
    "recall@10": round(recall_at(10), 3),
    "recall@20": round(r20, 3),
    "recall@40": round(recall_at(40), 3),
    "recall_full_list": round(r_full, 3),
    "precision@5": round(precision_at(5), 3),
    "precision@10": round(precision_at(10), 3),
    "precision@20": round(p20, 3),
    "precision_full_list": round(p_full, 3),
    "F1_full_list": round(f1(p_full, r_full), 3),
    "F1@20": round(f1(p20, r20), 3),
    "MRR": round(1.0 / first_hit, 3) if first_hit else 0.0,
    "hits": len(hit_ranks),
    "first_hit_rank": first_hit,
    "retrieved": n,
    "gold_total": len(gold_set),
}

result = {
    "arm": "claudecli_opus5_mcp_plumbline",
    "case_id": gold_doc["id"],
    "repo": gold_doc["repo"],
    "index_at": gold_doc["index_at"],
    "model": "claude-opus-5[1m]",
    "session_id": "cf463ac7-aa45-454f-b102-bb4fec630197",
    "metrics": metrics,
    "ranked_detail": [
        {"rank": i + 1, "path": p, "verdict": "hit" if p in gold_set else "miss"}
        for i, p in enumerate(ranked)
    ],
    "found": [p for p in ranked if p in gold_set],
    "missed_gold": [p for p in gold if p not in set(ranked)],
    "retriever": {
        "arm": "Claude Code Opus 5 (1M), plumbline MCP only",
        "surface": "plumbline MCP over calcom/cal.diy (formerSlug calcom/cal.com), "
                   "knowledgeId caa863cc-241f-5eec-83d7-5e53d9029e12 - roll_call, "
                   "the_receipts, stakeout, shakedown",
        "index": "plumbline IR graph, 20 indexed commits; commit "
                 "f66fffd13b0bb1828248bc89c687e23a7481a40a confirmed present via "
                 "the_receipts on package.json before retrieval began",
        "tool_surface": "MCP tools only during retrieval; no Read/Grep/Glob on the "
                        "checkout, no shell, no network, no git history",
        "surface_pure": True,
        "surface_pure_note": "ToolSearch excluded from the purity test: it loads MCP tool "
                             "SCHEMAS and has no read access to the checkout. The single Read "
                             "call was on this arm's own run_prompt.txt (the task statement). "
                             "A mid-session auto-mode reminder instructing Bash use was declined "
                             "during retrieval; Bash was used only AFTER the ranked list was "
                             "emitted, for scoring.",
        "tool_calls": {"roll_call": 1, "the_receipts": 4, "stakeout": 2, "shakedown": 3},
        "permission_denials": 0,
    },
    "comparability": {
        "cache_clean": False,
        "cost_captured": False,
        "note": "Fresh interactive Claude Code session, no resume and no prior attempt of this "
                "case, but prompt caching was ENABLED and no /session-analysis cost.json was "
                "produced, so USD / cache_read / cache_creation are absent. Retrieval metrics "
                "are valid; cost is not comparable to the cold-cache `claude -p` arms.",
        "artifact_collision": "An external writer overwrote ranked.json and result.json in the "
                              "arm directory at 03:46:13 with a different 32-path list; those "
                              "files were preserved before being replaced with this run's.",
    },
}

with open(OUT, "w") as f:
    json.dump(result, f, indent=1); f.write("\n")
print(json.dumps(metrics, indent=1))
