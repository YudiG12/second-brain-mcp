#!/usr/bin/env python3
"""Measures the live MCP server: write latency, write-to-searchable latency and search latency.

Usage: scripts/measure.py [runs]   (default 10; needs MCP_TOKEN in .dev.vars)
Writes notes under _bench/ and deletes them at the end. Prints a JSON summary.
DNS goes through Cloudflare's DNS-over-HTTPS, so a stale local resolver doesn't matter.
"""
import json, math, os, statistics, subprocess, sys, time, uuid

URL = "https://second-brain-mcp.yudiganeko.workers.dev"
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 10
POLL_EVERY, POLL_MAX = 3.0, 600.0
os.chdir(os.path.join(os.path.dirname(__file__), ".."))
TOKEN = next(l.split("=", 1)[1].strip() for l in open(".dev.vars") if l.startswith("MCP_TOKEN="))


def call(tool, args):
    """Calls one MCP tool; returns (seconds, text). The token goes through curl's stdin config, not argv."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
    cfg = f'url = "{URL}/{TOKEN}/mcp"\n'
    out = subprocess.run(
        ["curl", "-s", "--doh-url", "https://1.1.1.1/dns-query", "-m", "60", "-X", "POST", "--config", "-",
         "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream",
         "--data-binary", body, "-w", "\n__TIME__%{time_total}"],
        input=cfg, capture_output=True, text=True, check=True).stdout
    payload, t = out.rsplit("__TIME__", 1)
    data = next(l[5:] for l in payload.splitlines() if l.startswith("data:"))
    res = json.loads(data)
    if "error" in res or res["result"].get("isError"):
        raise RuntimeError(f"{tool} failed: {data[:200]}")
    return float(t), res["result"]["content"][0]["text"]


def stats(xs):
    xs = sorted(xs)
    return {"n": len(xs), "p50": round(statistics.median(xs), 2), "p90": round(xs[math.ceil(0.9 * len(xs)) - 1], 2), "max": round(xs[-1], 2)}


writes, visible, searches_kw, searches_sem, paths = [], [], [], [], []
try:
    for i in range(RUNS):
        tag = uuid.uuid4().hex[:12]
        path = f"_bench/{tag}.md"
        text = f"Benchmark note {tag}. Measuring how long the second brain takes to make a new note searchable."
        t, _ = call("write_note", {"path": path, "content": text})
        writes.append(t); paths.append(path)
        start = time.monotonic()
        while time.monotonic() - start < POLL_MAX:
            _, found = call("semantic_search", {"query": text, "topK": 10})
            if path in found:
                visible.append(round(time.monotonic() - start + t, 2))
                break
            time.sleep(POLL_EVERY)
        else:
            visible.append(None)
        searches_kw.append(call("search_notes", {"query": "railblocks"})[0])
        searches_sem.append(call("semantic_search", {"query": "decisões de carreira", "topK": 5})[0])
        print(f"run {i + 1}/{RUNS}: write {t:.2f}s, searchable after {visible[-1]}s", file=sys.stderr)
finally:
    for p in paths:
        try:
            call("delete_note", {"path": p})
        except Exception as e:  # keep cleaning up the rest
            print(f"could not delete {p}: {e}", file=sys.stderr)

ok = [v for v in visible if v is not None]
print(json.dumps({
    "server": URL, "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "runs": RUNS,
    "note": "Times in seconds, measured from the Mac, including network.",
    "write_note": stats(writes),
    "write_to_searchable": {**stats(ok), "never_visible": visible.count(None), "poll_every_s": POLL_EVERY, "gave_up_after_s": POLL_MAX} if ok else {"never_visible": RUNS},
    "search_notes": stats(searches_kw),
    "semantic_search": stats(searches_sem),
}, indent=2))
