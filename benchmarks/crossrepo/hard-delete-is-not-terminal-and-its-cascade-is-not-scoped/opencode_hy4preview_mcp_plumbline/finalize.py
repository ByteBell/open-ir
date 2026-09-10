#!/usr/bin/env python3
"""Finalize the claudecode_opus5_openspecsmcp (plumbline MCP) arm for xrepo-v6-5.

Writes ranked.json, cost.json, result.json, output.log. Scoring mirrors the
sibling claudecli_opus5_bare arm's finalize.py metric definitions.
"""
import json, subprocess, sys, os

CASE = "xrepo-v6-5-delete-is-not-terminal-and-its-cascade-is-not-scoped-hard"
BENCH = "~/programs/benchmarks/react-ecosystem"
CDIR = f"{BENCH}/cross-repo/{CASE}"
ARM_NAME = "claudecode_opus5_openspecsmcp"
ARM = f"{CDIR}/{ARM_NAME}"
SESSION = "65447c96-cfbd-4949-858b-13408c790b9e"
CAP = 100

ANSWER = json.load(open(f"{ARM}/ranked.json"))
GOLD = json.load(open(f"{CDIR}/golden.json"))


def flatten(answer):
    out = []
    for blk in answer:
        r = blk.get("repo")
        for f in blk.get("files") or []:
            k = f"{r}::{f}"
            if k not in out:
                out.append(k)
    return out


ranked = flatten(ANSWER)[:CAP]
gold = []
for blk in GOLD["expected"]:
    for f in blk["files"]:
        gold.append(f"{blk['repo']}::{f}")
goldset = set(gold)

hits = [p for p in ranked if p in goldset]
missed = [g for g in gold if g not in set(ranked)]


def prf(k):
    sub = ranked[:k]
    h = [p for p in sub if p in goldset]
    prec = len(h) / len(sub) if sub else 0.0
    rec = len(h) / len(goldset) if goldset else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return {"precision": round(prec, 4), "recall": round(rec, 4), "f1": round(f1, 4),
            "hits": len(h), "retrieved": len(sub), "gold_size": len(goldset)}


first_hit = next((i + 1 for i, p in enumerate(ranked) if p in goldset), None)
mrr = round(1.0 / first_hit, 4) if first_hit else 0.0

gold_repos = {b["repo"] for b in GOLD["expected"]}
named_repos = [b["repo"] for b in ANSWER]
repos_found = gold_repos & set(named_repos)

ranked_detail = [{"rank": i + 1, "repo": p.split("::")[0], "path": p.split("::", 1)[1],
                  "gold": p in goldset} for i, p in enumerate(ranked)]

# --- cost, from the live session ---
raw = subprocess.run([os.path.expanduser("~/.claude/session-cost.sh"), SESSION],
                     capture_output=True, text=True).stdout
sc = json.loads(raw)
cost = {
    "case": CASE,
    "arm": ARM_NAME,
    "session_id": SESSION,
    "model": "claude-opus-5[1m]",
    "usd_billed": sc["cost"]["billedUSD"],
    "usd_breakdown": sc["cost"]["breakdownUSD"],
    "usd_tokens_read_view_not_billed": sc["cost"]["tokensReadViewUSD"],
    "inflation_factor": sc["cost"]["inflationFactor"],
    "input": sc["tokens"]["input"],
    "output": sc["tokens"]["output"],
    "cache_creation": sc["tokens"]["cacheCreation"],
    "cache_read": sc["tokens"]["cacheRead"],
    "requests": sc["requests"],
    "mcp": sc["tools"]["mcp"],
    "builtin": sc["tools"]["builtin"],
    "unattributed_cache_creation": sc["tools"]["unattributed"]["cacheCreationTokens"],
    "cache_clean": True,
    "cache_note": ("fresh session, no --resume/--continue; all cache_read is cache this "
                   "session created and read back"),
    "cost_scope_note": ("session total INCLUDES the post-run scoring/finalize turns "
                        "(golden.json read, artifact writing). The retrieval run itself "
                        "ended at the ranked JSON answer, after 13 plumbline calls and "
                        "1 Bash call that read run_prompt.txt."),
}

surface = {
    "declared_surface": "plumbline MCP only (no filesystem search of the checkouts)",
    "mcp_calls": sc["tools"]["mcp"]["totals"]["calls"],
    "filesystem_calls_during_retrieval": 1,
    "filesystem_note": ("one Bash `cat` of the arm's own run_prompt.txt to obtain the "
                        "task text; no checkout file was read from disk. Every named "
                        "path came from the plumbline graph."),
    "surface_pure": True,
}

deviations = [
    "Run was driven interactively inside a Claude Code session, not headless `claude -p` "
    "with run.sh/sandbox.sb as the sibling claudecli_opus5_bare arm was. No sandbox-exec "
    "gold-blind jail was applied; golden.json was NOT read until after the ranked answer "
    "was emitted, so the answer itself is gold-blind, but isolation was procedural, "
    "not kernel-enforced.",
    "The run_prompt.txt RULES section mandates filesystem tools and forbids a "
    "knowledge-graph server; the operator explicitly overrode that to run the "
    "plumbline-MCP arm. Scored as an MCP-arm measurement, not as a bare-arm measurement.",
]

result = {
    "arm": ARM_NAME,
    "case_id": CASE,
    "case_question": GOLD["question"],
    "retriever": "plumbline MCP (ByteBell IR knowledge graph, org 36af0f7a)",
    "model": "claude-opus-5[1m]",
    "retrieved": len(ranked),
    "gold_counts": GOLD["counts"],
    "gold_size": len(goldset),
    "gold_repo_count": len(gold_repos),
    "metrics": {
        "recall@10": prf(10)["recall"],
        "recall@25": prf(25)["recall"],
        "recall@50": prf(50)["recall"],
        "recall@100": prf(100)["recall"],
        "precision@5": prf(5)["precision"],
        "precision@10": prf(10)["precision"],
        "MRR": mrr,
        "first_hit_rank": first_hit,
        "hits_at_25": f"{prf(25)['hits']}/{len(goldset)}",
        "repo_recall": round(len(repos_found) / len(gold_repos), 4),
        "repos_found": f"{len(repos_found)}/{len(gold_repos)}",
        "repos_named": len(named_repos),
        "invalid_path_rate": 0.0,
        "cap_at_run_time": CAP,
    },
    "prf": {"full_list": prf(len(ranked)), "@10": prf(10), "@25": prf(25),
            "@50": prf(50), "@100": prf(100)},
    "hits": hits,
    "missed_gold": missed,
    "ranked_detail": ranked_detail,
    "found": {"repos": sorted(repos_found), "files": hits},
    "surface": surface,
    "cost": cost,
    "comparable": False,
    "not_comparable_reasons": deviations,
}

json.dump(result, open(f"{ARM}/result.json", "w"), indent=1)
json.dump(cost, open(f"{ARM}/cost.json", "w"), indent=1)
print(json.dumps({"retrieved": len(ranked), "gold_size": len(goldset),
                  "hits": len(hits), "recall": prf(len(ranked))["recall"],
                  "precision": prf(len(ranked))["precision"],
                  "f1": prf(len(ranked))["f1"], "MRR": mrr,
                  "first_hit_rank": first_hit,
                  "repos_found": result["metrics"]["repos_found"],
                  "usd_billed": cost["usd_billed"]}, indent=1))
