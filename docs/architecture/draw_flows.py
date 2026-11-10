#!/usr/bin/env python3
"""One map per flow (docs/architecture/flows/*.svg), in the same style as v2.svg.
Numbers on the arrows give the order. Run: python3 docs/architecture/draw_flows.py"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from draw import box, arrow, svg  # also redraws v1/v2, unchanged

OUT = os.path.join(os.path.dirname(__file__), "flows")
def save(name, w, h, title, sub, parts):
    open(os.path.join(OUT, name + ".svg"), "w").write(svg(w, h, title, sub, "".join(parts)))

client = lambda x, y: box(x, y, "MCP client", "Claude · ChatGPT · Code", "slate", icons=("chat",))
endpoint = lambda x, y, cap=None: box(x, y, "MCP endpoint", "Worker · fetch()", "indigo", cap, icons=("workers",), kind="part")

# 1. sign-in
save("1-sign-in", 1160, 460, "Flow 1 · Sign-in", "OAuth 2.1 with GitHub as the identity provider; only the owner's account gets a grant.", [
    client(40, 200), endpoint(460, 200),
    box(880, 80, "GitHub", "identity only", "slate", "user id == OWNER_GITHUB_ID?", icons=("github",)),
    box(880, 340, "KV", "OAuth grants", "slate", "token checked on every call", icons=("key",)),
    arrow([(260, 210), (460, 210)], "1. register", flow="auth"),
    arrow([(570, 200), (570, 112), (880, 112)], "2. sign in", at=0.25, flow="auth"),
    arrow([(880, 132), (630, 132), (630, 200)], "3. callback", at=0.25, flow="auth"),
    arrow([(570, 264), (570, 372), (880, 372)], "4. store grant", flow="auth"),
    arrow([(460, 234), (260, 234)], "5. access token", flow="auth"),
    arrow([(260, 258), (460, 258)], "6. /mcp + Bearer", flow="auth"),
])

# 2. write
save("2-write", 1560, 400, "Flow 2 · Write a note", "One Durable Object per repository applies writes one at a time; the index catches up in the background.", [
    client(40, 110), endpoint(460, 110),
    box(880, 110, "RepoWriter", "Durable Object · mutex", "indigo", "stale expected_version → conflict", icons=("lock",), kind="part"),
    box(1300, 110, "Artifacts", "Git · source of truth", "green", "branch moved → re-apply (3 tries)", icons=("branch",)),
    box(880, 290, "Queue", "index-jobs", "orange", icons=("queue",)),
    arrow([(260, 126), (460, 126)], "1. write_note", flow="write"),
    arrow([(680, 142), (880, 142)], "2. one at a time", flow="write"),
    arrow([(1100, 142), (1300, 142)], "3. commit + push", flow="write"),
    arrow([(570, 174), (570, 322), (880, 322)], "4. enqueue path", flow="index"),
    arrow([(460, 160), (260, 160)], "5. ok · version", flow="write"),
])

# 4. read
save("4-read", 1140, 340, "Flow 4 · Read a note", "Straight from Git; the reply carries the version for a later write.", [
    client(40, 160), endpoint(460, 160),
    box(880, 160, "Artifacts", "Git · source of truth", "green", icons=("branch",)),
    arrow([(260, 176), (460, 176)], "1. read_note", flow="read"),
    arrow([(680, 176), (880, 176)], "2. read file", flow="read"),
    arrow([(880, 208), (680, 208)], "3. content", flow="read"),
    arrow([(460, 208), (260, 208)], "4. text + version", flow="read"),
])

# 3. index
save("3-index", 1640, 440, "Flow 3 · Index in the background", "Two producers in real time (the daily repair is flow 6), one consumer: the only writer of both indexes.", [
    endpoint(40, 80, "after each write"),
    box(40, 200, "Artifacts", "push event", "green", icons=("branch",)),
    box(460, 200, "Queue", "index-jobs · path only", "orange", icons=("queue",)),
    box(880, 200, "Queue consumer", "Worker · queue()", "indigo", "same sha → skip · head moved → requeue", icons=("workers",), kind="part"),
    box(1380, 60, "D1", "manifest · FTS5 chunks", "red", icons=("database",)),
    box(1380, 200, "Workers AI", "model API · bge-m3", "teal", icons=("sparkles",), kind="api"),
    box(1380, 340, "Vectorize", "semantic index", "teal", icons=("search",)),
    arrow([(260, 112), (400, 112), (400, 214), (460, 214)], "1. enqueue", flow="index"),
    arrow([(260, 232), (460, 232)], "1. pushed", flow="index"),
    arrow([(680, 232), (880, 232)], "2. deliver", flow="index"),
    arrow([(1100, 232), (1380, 232)], "3. embed chunks", flow="index"),
    arrow([(1100, 248), (1150, 248), (1150, 372), (1380, 372)], "4. upsert h-seq", flow="index"),
    arrow([(1100, 216), (1150, 216), (1150, 92), (1380, 92)], "5. manifest + FTS", flow="index"),
])

# 6. reconcile
save("6-reconcile", 1160, 480, "Flow 6 · Reconciliation", "The schedule is a setting of the Workflow itself (also started by POST /admin/reconcile); it enqueues only what differs.", [
    '<rect x="20" y="160" width="680" height="140" rx="8" fill="#5B5BD6" fill-opacity="0.06" stroke="#5B5BD6" stroke-width="1.5" stroke-dasharray="6 4"/>'
    '<text x="34" y="292" class="gl" style="fill:#5B5BD6">WORKFLOW reconcile · Settings › Schedules</text>',
    box(40, 184, "Schedule", "cron 0 4 * * * (UTC)", "indigo", icons=("workflow",), kind="part"),
    box(460, 184, "Reconcile", "Workflow · durable steps", "indigo", icons=("workflow",), kind="part"),
    box(880, 80, "Artifacts", "Git · source of truth", "green", icons=("branch",)),
    box(880, 184, "D1", "manifest · FTS5 chunks", "red", icons=("database",)),
    box(880, 340, "Queue", "index-jobs", "orange", "missing · changed · orphans · keyword gaps", icons=("queue",)),
    arrow([(260, 216), (460, 216)], "start", flow="index"),
    arrow([(570, 184), (570, 112), (880, 112)], "1. notes + sha", flow="index"),
    arrow([(680, 216), (880, 216)], "2. what's indexed", flow="index"),
    arrow([(570, 248), (570, 372), (880, 372)], "3. diff · 4. enqueue", flow="index"),
])

# 7. failure
save("7-failure", 1560, 360, "Flow 7 · A job that keeps failing", "Retries with backoff, then the dead-letter queue. The note stays out of the index until flow 6 enqueues it again.", [
    box(40, 100, "Queue", "retry 10·20·40·80·160 s", "orange", icons=("queue",)),
    box(460, 100, "Queue consumer", "Worker · queue()", "indigo", icons=("workers",), kind="part"),
    box(880, 100, "DLQ", "index-jobs-dlq", "red", icons=("queue",)),
    box(1300, 100, "DLQ consumer", "Worker · queue()", "indigo", icons=("workers",), kind="part"),
    box(1300, 250, "D1", "alerts table", "red", "nothing reads it yet", icons=("database",)),
    arrow([(260, 116), (460, 116)], "1. deliver", flow="index"),
    arrow([(460, 150), (260, 150)], "2. throws", flow="fail"),
    arrow([(150, 164), (150, 230), (990, 230), (990, 164)], "3. after 5 failures", flow="fail"),
    arrow([(1100, 132), (1300, 132)], "4. deliver", flow="fail"),
    arrow([(1410, 164), (1410, 250)], "5. alert row · ack", flow="fail"),
])

# 5. search
save("5-search", 1560, 380, "Flow 5 · Search", "Keyword and meaning in parallel, fused by reciprocal rank: 1 / (60 + rank).", [
    client(40, 200), endpoint(460, 200, "RRF fuse · best chunk per note"),
    box(880, 80, "D1", "FTS5 · BM25", "red", icons=("database",)),
    box(880, 200, "Workers AI", "model API · bge-m3", "teal", icons=("sparkles",), kind="api"),
    box(1300, 200, "Vectorize", "nearest chunks", "teal", "cosine ≥ 0.30", icons=("search",)),
    arrow([(260, 216), (460, 216)], "1. search_notes", flow="read"),
    arrow([(570, 200), (570, 112), (880, 112)], "2a. keyword", flow="read"),
    arrow([(680, 232), (880, 232)], "2b. embed query", flow="read"),
    arrow([(1100, 232), (1300, 232)], "3. query vector", flow="read"),
    arrow([(460, 250), (260, 250)], "4. ranked notes", flow="read"),
])
print("flows ok")
