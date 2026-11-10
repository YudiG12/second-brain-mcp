#!/usr/bin/env python3
"""Measures the live MCP server: write latency, write-to-searchable latency and search latency.

Usage: scripts/measure.py [runs]   (default 10)
Auth: ACCESS_TOKEN, an OAuth access token for /mcp (from any connected client, or by running the
authorization flow); it is sent as a Bearer header through curl's stdin, never on the command line.
Writes notes under _bench/ and deletes them at the end. Prints a JSON summary.
DNS goes through Cloudflare's DNS-over-HTTPS, so a stale local resolver doesn't matter.
"""
import json, math, os, re, statistics, subprocess, sys, time, uuid

URL = os.environ.get("SECOND_BRAIN_URL") or subprocess.run(["node", "scripts/config.mjs", "PUBLIC_URL"], check=True, capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), "..")).stdout.strip()
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 10
POLL_EVERY, POLL_MAX = 3.0, 600.0
os.chdir(os.path.join(os.path.dirname(__file__), ".."))
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN") or sys.exit("Set ACCESS_TOKEN to an OAuth access token for /mcp.")


def call(tool, args):
    """Calls one MCP tool; returns (seconds, text). The token goes through curl's stdin config, not argv."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
    cfg = f'url = "{URL}/mcp"\nheader = "Authorization: Bearer {ACCESS_TOKEN}"\n'
    out = subprocess.run(
        ["curl", "-s", "--doh-url", "https://1.1.1.1/dns-query", "-m", "60", "-X", "POST", "--config", "-",
         "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream",
         "--data-binary", body, "-w", "\n__TIME__%{time_total}"],
        input=cfg, capture_output=True, text=True, check=True).stdout
    payload, t = out.rsplit("__TIME__", 1)
    data = next((l[5:] for l in payload.splitlines() if l.startswith("data:")), None)
    if data is None:
        raise RuntimeError(f"{tool}: unexpected response: {payload[:200]}")
    res = json.loads(data)
    if "error" in res or res["result"].get("isError"):
        raise RuntimeError(f"{tool} failed: {data[:200]}")
    return float(t), res["result"]["content"][0]["text"]


def stats(xs, digits=2):
    """Nearest-rank percentiles (indicative at n=10), plus the raw samples."""
    s = sorted(xs)
    pct = lambda p: round(s[math.ceil(p * len(s)) - 1], digits)
    return {"n": len(s), "p50": pct(0.5), "p90": pct(0.9), "max": round(s[-1], digits), "samples": [round(x, digits) for x in xs]}


writes, visible, visible_kw, searches_kw, searches_sem = [], [], [], [], []  # both are search_notes: a keyword-ish and a meaning-ish query
reads, edits, local_reads, local_writes = [], [], [], []
failures = []  # calls that errored or timed out (60 s); a run with one keeps going  # ADR 014: what the Mac pays now vs a local file
note_count = len(call("list_notes", {})[1].splitlines())
for i in range(RUNS):
    tag = uuid.uuid4().hex[:12]
    word = f"zq{tag}"  # a word no other note has, for the keyword index
    path = f"_bench/{tag}.md"
    text = f"Benchmark note {word}. Measuring how long the second brain takes to make a new note searchable."
    try:
      try:
          t, _ = call("write_note", {"path": path, "content": text})  # cold or warm is not controlled
          writes.append(t)
          start = time.monotonic()
          sem_at = kw_at = None
          while time.monotonic() - start < POLL_MAX and (sem_at is None or kw_at is None):
              if kw_at is None and path in call("search_notes", {"query": word})[1]:
                  kw_at = time.monotonic() - start + t
              if sem_at is None and re.search(re.escape(path) + r" \((semantic|both)\)", call("search_notes", {"query": text})[1]):
                  sem_at = time.monotonic() - start + t
              if sem_at is None or kw_at is None:
                  time.sleep(POLL_EVERY)
          visible.append(sem_at)
          visible_kw.append(kw_at)
          # warm: these run right after the polling loop
          searches_kw.append(call("search_notes", {"query": "projeto"})[0])
          searches_sem.append(call("search_notes", {"query": "decisões de carreira"})[0])
          reads.append(call("read_note", {"path": path})[0])
          edits.append(call("edit_note", {"path": path, "old_text": "Benchmark note", "new_text": "Benchmark note (edited)"})[0])
          # the same read and write on a local file, as the Mac did with its clone before ADR 014
          local = os.path.join("/tmp", f"bench-{tag}.md")
          t0 = time.perf_counter(); open(local, "w").write(text); local_writes.append(time.perf_counter() - t0)
          t0 = time.perf_counter(); open(local).read(); local_reads.append(time.perf_counter() - t0)
          os.remove(local)
          print(f"run {i + 1}/{RUNS}: write {t:.2f}s, keyword after {kw_at}s, semantic after {sem_at}s", file=sys.stderr)
      except Exception as e:
        failures.append({"run": i + 1, "error": str(e)[:200]})
        print(f"run {i + 1}/{RUNS}: failed: {str(e)[:200]}", file=sys.stderr)
    finally:
        # delete every run's note before the next one, so runs don't compete in search and the note count stays fixed
        try:
            call("delete_note", {"path": path})
        except Exception as e:
            print(f"could not delete {path}: {e}", file=sys.stderr)

ok = [v for v in visible if v is not None]
print(json.dumps({
    "server": URL, "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "runs": RUNS,
    "note": "Seconds, measured from the Mac, including network. Nearest-rank percentiles, indicative at n=10. Searches are warm.",
    "notes_in_repo": note_count,
    "write_note": stats(writes),
    "write_to_searchable": {**stats(ok, 0), "never_visible": visible.count(None), "resolution_s": "about ±4.5 (3 s sleep + one query per poll)", "gave_up_after_s": POLL_MAX} if ok else {"never_visible": RUNS},
    "write_to_keyword_searchable": {**stats([v for v in visible_kw if v is not None], 1), "never_visible": visible_kw.count(None)} if any(v is not None for v in visible_kw) else {"never_visible": RUNS},
    "read_note": stats(reads),
    "edit_note": stats(edits),
    "local_file_read_ms": stats([x * 1000 for x in local_reads], 3),
    "local_file_write_ms": stats([x * 1000 for x in local_writes], 3),
    "failures": failures,
    "search_notes (keyword query)": stats(searches_kw),
    "search_notes (meaning query)": stats(searches_sem),
}, indent=2))
