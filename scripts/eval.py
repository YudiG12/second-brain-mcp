#!/usr/bin/env python3
"""Search eval: runs a golden set against the live search_notes and prints recall@k and the misses.

Usage: scripts/eval.py [golden.jsonl] [k]   (default ~/.config/second-brain/golden.jsonl, k=5)
Golden set: one JSON per line, {"query": "...", "expected": "path/to/note.md"}. It holds your own
searches, so keep it outside the repo. Run it before and after any change to search, chunking or
embeddings, and compare the numbers.
Auth: ACCESS_TOKEN, as in measure.py:  export ACCESS_TOKEN=$(node scripts/token.mjs) && scripts/eval.py
"""
import json, os, re, subprocess, sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))
URL = os.environ.get("SECOND_BRAIN_URL") or subprocess.run(["node", "scripts/config.mjs", "PUBLIC_URL"], check=True, capture_output=True, text=True).stdout.strip()
GOLDEN = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.config/second-brain/golden.jsonl")
K = int(sys.argv[2]) if len(sys.argv) > 2 else 5
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN") or sys.exit("Set ACCESS_TOKEN to an OAuth access token for /mcp.")


def search(query):
    """Calls search_notes; returns the note paths in rank order. The token goes through curl's stdin."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search_notes", "arguments": {"query": query}}})
    cfg = f'url = "{URL}/mcp"\nheader = "Authorization: Bearer {ACCESS_TOKEN}"\n'
    out = subprocess.run(["curl", "-s", "--doh-url", "https://1.1.1.1/dns-query", "-m", "60", "-X", "POST", "--config", "-",
                          "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream", "--data-binary", body],
                         input=cfg, capture_output=True, text=True, check=True).stdout
    data = next((l[5:] for l in out.splitlines() if l.startswith("data:")), None)
    if data is None:
        raise RuntimeError(f"unexpected response: {out[:200]}")
    msg = json.loads(data)
    if "error" in msg:
        raise RuntimeError(f"search_notes failed: {msg['error']}")
    res = msg["result"]
    if res.get("isError"):
        raise RuntimeError(res["content"][0]["text"][:200])
    # Each hit starts a block with "<path> (keyword|semantic|both)"; the lines after it are note text,
    # which may cite other .md paths, so only that first line counts.
    paths = []
    for p in re.findall(r"^(.+?) \((?:keyword|semantic|both)\)$", res["content"][0]["text"], re.M):
        if p not in paths:
            paths.append(p)
    return paths


cases = [json.loads(l) for l in open(GOLDEN) if l.strip()]
if not cases:
    sys.exit(f"No cases in {GOLDEN}.")
hits, rr, misses = 0, 0.0, []
for c in cases:
    ranked = search(c["query"])
    rank = ranked.index(c["expected"]) + 1 if c["expected"] in ranked else None
    if rank and rank <= K:
        hits += 1
    rr += 1 / rank if rank else 0
    if rank != 1:
        misses.append((rank, c["query"], c["expected"], ranked[:K]))

print(json.dumps({"cases": len(cases), f"recall@{K}": round(hits / len(cases), 3), "mrr": round(rr / len(cases), 3)}))
for rank, q, exp, top in sorted(misses, key=lambda m: m[0] or 99, reverse=True):
    print(f"\n{'MISS' if not rank or rank > K else f'rank {rank}'}: {q}\n  expected {exp}\n  got      {', '.join(top)}")
