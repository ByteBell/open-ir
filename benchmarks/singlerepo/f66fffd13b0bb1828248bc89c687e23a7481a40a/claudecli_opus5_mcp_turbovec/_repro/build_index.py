#!/usr/bin/env python3
"""Build a turbovec (TurboQuant) vector index over calcom/cal.com at the case commit.

Chunks every text source file into overlapping line windows, embeds each with
sentence-transformers/all-MiniLM-L6-v2 (384-d, normalized -> dot == cosine), and
stores them in a turbovec IdMapIndex. The chunk text itself lives in chunks.jsonl,
so the MCP server can serve retrieval without ever touching the filesystem.
"""
import json, os, sys, time
from pathlib import Path
import numpy as np
from sentence_transformers import SentenceTransformer
from turbovec import IdMapIndex

# This script lives at <case>/claudecli_opus5_mcp_turbovec/_repro/build_index.py,
# so the case root — and therefore the commit — is derived from its own location.
ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT / "repo"
OUT = ROOT / "turbovec" / "index"
OUT.mkdir(parents=True, exist_ok=True)
COMMIT = ROOT.name

EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx",
        ".prisma", ".sql", ".css", ".scss", ".yml", ".yaml", ".sh", ".env"}
MAX_BYTES = 400_000
WIN, STRIDE = 20, 15

def files():
    import subprocess
    out = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True).stdout
    for rel in out.splitlines():
        p = REPO / rel
        if p.suffix.lower() not in EXTS:
            continue
        try:
            if p.stat().st_size > MAX_BYTES or p.stat().st_size == 0:
                continue
        except OSError:
            continue
        yield rel, p

def chunks():
    for rel, p in files():
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue
        if not lines:
            continue
        for s in range(0, len(lines), STRIDE):
            body = lines[s:s + WIN]
            if not any(l.strip() for l in body):
                continue
            yield {"path": rel, "start": s + 1, "end": min(s + WIN, len(lines)),
                   "text": "\n".join(body)}
            if s + WIN >= len(lines):
                break

def main():
    t0 = time.time()
    cs = list(chunks())
    print(f"{len(cs)} chunks from {len(set(c['path'] for c in cs))} files "
          f"({time.time()-t0:.1f}s)", flush=True)

    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    print(f"model loaded, max_seq_length={model.max_seq_length}", flush=True)

    # Path is part of the embedded text so filename/dir tokens participate in matching.
    texts = [f"{c['path']}\n{c['text']}" for c in cs]
    vecs = model.encode(texts, batch_size=256, normalize_embeddings=True,
                        show_progress_bar=True, convert_to_numpy=True)
    vecs = np.asarray(vecs, dtype=np.float32)
    print(f"embedded {vecs.shape} in {time.time()-t0:.1f}s", flush=True)

    idx = IdMapIndex(dim=vecs.shape[1], bit_width=4)
    idx.add_with_ids(vecs, np.arange(len(cs), dtype=np.uint64))
    idx.write(str(OUT / "calcom.tvim"))

    with open(OUT / "chunks.jsonl", "w") as f:
        for i, c in enumerate(cs):
            f.write(json.dumps({"id": i, **c}) + "\n")
    json.dump({"chunks": len(cs), "dim": int(vecs.shape[1]), "bit_width": 4,
               "model": "sentence-transformers/all-MiniLM-L6-v2",
               "window": WIN, "stride": STRIDE,
               "repo": "calcom/cal.com", "commit": COMMIT,
               "files": len(set(c["path"] for c in cs)),
               "build_seconds": round(time.time() - t0, 1)},
              open(OUT / "meta.json", "w"), indent=2)
    print(f"index written in {time.time()-t0:.1f}s", flush=True)

if __name__ == "__main__":
    main()
