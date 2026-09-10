#!/usr/bin/env python3
"""turbovector MCP — retrieval over calcom/cal.com at the case commit, backed ONLY by a
turbovec (TurboQuant) vector index.

Every tool is served from the turbovec IdMapIndex plus its chunk store. The
process never reads the repository from disk at request time, so an agent given
this server and nothing else can only reach the code through vector search.
"""
import json, sys
from pathlib import Path
import numpy as np
from mcp.server.mcpserver import MCPServer

# Lives at <case>/claudecli_opus5_mcp_turbovec/_repro/turbovector_mcp.py.
ROOT = Path(__file__).resolve().parents[2]
IDX = ROOT / "turbovec" / "index"

META = json.loads((IDX / "meta.json").read_text())
CHUNKS = [json.loads(l) for l in (IDX / "chunks.jsonl").read_text().splitlines()]
BY_PATH = {}
for c in CHUNKS:
    BY_PATH.setdefault(c["path"], []).append(c)
for v in BY_PATH.values():
    v.sort(key=lambda c: c["start"])

from turbovec import IdMapIndex
from sentence_transformers import SentenceTransformer

INDEX = IdMapIndex.load(str(IDX / "calcom.tvim"))
MODEL = SentenceTransformer(META["model"])

mcp = MCPServer(
    name="turbovector",
    instructions=(
        f"Vector retrieval over {META['repo']} at commit {META['commit']}. "
        f"{META['chunks']} chunks across {META['files']} files, embedded with "
        f"{META['model']} and indexed with turbovec (TurboQuant, "
        f"{META['bit_width']}-bit). `search` is the ONLY way to discover code; "
        "`get_file` and `read_lines` serve text that is already in the index."
    ),
)


def _embed(q: str) -> np.ndarray:
    return np.asarray(MODEL.encode([q], normalize_embeddings=True,
                                   convert_to_numpy=True), dtype=np.float32)


@mcp.tool(description=(
    "Semantic search over the indexed repository. Returns the top-k matching code "
    "chunks with path, line range, score and text. This is the only discovery "
    "mechanism available — describe the code you want in natural language, or paste "
    "an identifier / signature."))
def search(query: str, k: int = 10) -> str:
    k = max(1, min(int(k), 50))
    scores, ids = INDEX.search(_embed(query), k=k)
    out = []
    for s, i in zip(np.ravel(scores).tolist(), np.ravel(ids).tolist()):
        c = CHUNKS[int(i)]
        out.append({"id": int(i), "score": round(float(s), 4), "path": c["path"],
                    "lines": f"{c['start']}-{c['end']}", "text": c["text"]})
    return json.dumps({"query": query, "hits": out}, indent=2)


@mcp.tool(description=(
    "Return a whole file, reassembled from the chunks held in the index. Use a path "
    "that a `search` hit reported. Long files are truncated; use read_lines for a "
    "specific window."))
def get_file(path: str, max_lines: int = 1200) -> str:
    cs = BY_PATH.get(path)
    if not cs:
        near = [p for p in BY_PATH if path.lower() in p.lower()][:10]
        return json.dumps({"error": f"{path} is not in the index", "similar": near})
    lines: dict[int, str] = {}
    for c in cs:
        for n, l in enumerate(c["text"].split("\n"), start=c["start"]):
            lines[n] = l
    hi = max(lines)
    body = "\n".join(f"{n}\t{lines.get(n, '')}" for n in range(1, min(hi, max_lines) + 1))
    return json.dumps({"path": path, "lines": f"1-{min(hi, max_lines)}", "total_lines": hi,
                       "truncated": hi > max_lines, "text": body})


@mcp.tool(description=(
    "Return a specific line range of an indexed file, from the index's chunk store."))
def read_lines(path: str, start: int, end: int) -> str:
    cs = BY_PATH.get(path)
    if not cs:
        return json.dumps({"error": f"{path} is not in the index"})
    lines: dict[int, str] = {}
    for c in cs:
        for n, l in enumerate(c["text"].split("\n"), start=c["start"]):
            lines[n] = l
    start, end = max(1, int(start)), min(int(end), max(lines))
    body = "\n".join(f"{n}\t{lines.get(n, '')}" for n in range(start, end + 1))
    return json.dumps({"path": path, "lines": f"{start}-{end}", "text": body})


@mcp.tool(description="What this index covers: repo, commit, model, chunk and file counts.")
def index_info() -> str:
    return json.dumps(META, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
