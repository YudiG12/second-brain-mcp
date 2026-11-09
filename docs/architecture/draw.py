#!/usr/bin/env python3
"""Draws the architecture maps (docs/architecture/v1.svg, v2.svg) in the Ganeko Notebook style:
solid colored boxes with white text, navy captions, dashed arrows, solid pill labels.
Run: python3 docs/architecture/draw.py"""
import html, json, os

# Brand marks from Simple Icons (CC0, https://simpleicons.org), filled; the rest are Lucide-style
# line icons (ISC), like the Ganeko Notebook's icon set.
BRANDS = json.load(open(os.path.join(os.path.dirname(__file__), "brands.json")))
LUCIDE = {
    "cpu": '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    "lock": '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "branch": '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    "queue": '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    "workflow": '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
    "database": '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    "key": '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
    "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    "sparkles": '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>',
    "terminal": '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    "chat": '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
}

def glyph(name, x, y, size=26):
    """A white icon at (x, y): a brand mark (filled) or a Lucide icon (stroked)."""
    k = size / 24
    if name in BRANDS:
        return f'<path transform="translate({x},{y}) scale({k})" d="{BRANDS[name]}" fill="#fff"/>'
    return f'<g transform="translate({x},{y}) scale({k})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{LUCIDE[name]}</g>'

C = dict(indigo="#5B5BD6", purple="#8E6FCB", teal="#3FA796", green="#2F8A5B", red="#D1495B", orange="#E08A3C", slate="#4A5866")
NAVY, MUTED, BG, LINE = "#1B2632", "#4A5D72", "#FCFAF7", "#677A8E"
W, H = 220, 64

def box(x, y, title, sub, color, caption=None, w=W, icons=()):
    t = f'<rect x="{x}" y="{y}" width="{w}" height="{H}" rx="6" fill="{C[color]}"/>'
    # icons on the left; text centred in the space that's left
    for i, name in enumerate(icons):
        t += glyph(name, x + 14 + i * 32, y + 19)
    left = x + (14 + 32 * len(icons) if icons else 0)
    cx = left + (x + w - left) / 2
    t += f'<text x="{cx}" y="{y + 27}" text-anchor="middle" class="t">{html.escape(title)}</text>'
    t += f'<text x="{cx}" y="{y + 47}" text-anchor="middle" class="s">{html.escape(sub)}</text>'
    if caption:
        t += f'<text x="{x + w/2}" y="{y + H + 18}" text-anchor="middle" class="c">{html.escape(caption)}</text>'
    return t

def arrow(points, label=None, at=0.5, both=False):
    d = "M" + " L".join(f"{x},{y}" for x, y in points)
    t = f'<path d="{d}" class="a" marker-end="url(#m)"{" marker-start=\"url(#ms)\"" if both else ""}/>'
    if label:
        # label on the longest segment
        segs = list(zip(points, points[1:]))
        (x1, y1), (x2, y2) = max(segs, key=lambda s: abs(s[1][0]-s[0][0]) + abs(s[1][1]-s[0][1]))
        lx, ly = x1 + (x2 - x1) * at, y1 + (y2 - y1) * at
        w = 7.2 * len(label) + 16
        t += f'<rect x="{lx - w/2}" y="{ly - 11}" width="{w}" height="22" rx="11" fill="{NAVY}"/>'
        t += f'<text x="{lx}" y="{ly + 4}" text-anchor="middle" class="p">{html.escape(label)}</text>'
    return t

def svg(width, height, title, subtitle, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" font-family="Onest, Inter, system-ui, sans-serif">
<defs>
<marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>
<marker id="ms" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>
<style>.t{{fill:#fff;font-size:15px;font-weight:700}}.s{{fill:#fff;font-size:12px;opacity:.92}}.c{{fill:{MUTED};font-size:12px}}
.a{{fill:none;stroke:{LINE};stroke-width:1.6;stroke-dasharray:6 5}}.p{{fill:#fff;font-size:11.5px;font-weight:600}}
.h{{fill:{NAVY};font-size:22px;font-weight:800}}.hs{{fill:{MUTED};font-size:13px}}.g{{fill:none;stroke:#E6D5C1;stroke-width:1.5;stroke-dasharray:2 4}}.gl{{fill:#8C6A43;font-size:12px;font-weight:600}}</style>
</defs>
<rect width="100%" height="100%" fill="{BG}"/>
<text x="32" y="44" class="h">{html.escape(title)}</text><text x="32" y="66" class="hs">{html.escape(subtitle)}</text>
{body}
</svg>'''

# ---------- v1 ----------
v1 = []
v1.append(box(40, 226, "Claude · ChatGPT", "MCP clients", "slate", "web and phone", icons=("claude", "chat")))
v1.append(box(40, 330, "Claude Code", "MCP client", "slate", "on the Mac", icons=("terminal",)))
v1.append(box(40, 508, "Mac", "notes clone + hooks", "slate", "pull on prompts, push after answers", icons=("apple",)))
v1.append(box(420, 226, "Worker", "cerebro-mcp · 9 tools", "indigo", "v1 names, renamed in v2", icons=("workers",)))
v1.append(box(800, 226, "GitHub repo", "segundo-cerebro", "green", "source of truth · REST API", icons=("github",)))
v1.append(box(800, 420, "Workers AI", "bge-m3 embeddings", "teal", icons=("sparkles",)))
v1.append(box(800, 600, "Vectorize", "semantic index", "teal", "derived, rebuildable", icons=("search",)))
v1.append(arrow([(260, 258), (420, 258)], "/<token>/mcp"))
v1.append(arrow([(260, 362), (340, 362), (340, 280), (420, 280)]))
v1.append(arrow([(640, 246), (800, 246)], "read · commit"))
v1.append(arrow([(800, 274), (640, 274)], "push webhook"))
v1.append(arrow([(560, 290), (560, 452), (800, 452)], "embed", at=0.5))
v1.append(arrow([(500, 290), (500, 632), (800, 632)], "upsert · query", at=0.5))
v1.append(arrow([(40, 540), (22, 540), (22, 712), (1060, 712), (1060, 258), (1020, 258)], "git pull / push", at=0.5, both=True))
open(os.path.join(os.path.dirname(__file__), "v1.svg"), "w").write(svg(1120, 650, "Second Brain MCP · v1", "Notes in a GitHub repo, a push webhook re-indexes, a token in the URL opens everything.", '<g transform="translate(0,-110)">' + "".join(v1) + "</g>"))

# ---------- v2 ----------
# Columns: outside (A) | Worker & runners (B) | storage & queue (C) | indexes & AI (D)
A, B, Cx, D = 40, 420, 800, 1180
v2 = []
v2.append('<rect x="390" y="92" width="1040" height="640" rx="10" class="g"/>' + f'<path transform="translate(404,98) scale(0.75)" d="{BRANDS["cloudflare"]}" fill="#F38020"/>' + '<text x="428" y="112" class="gl">CLOUDFLARE</text>')
v2.append(box(A, 110, "GitHub", "sign-in only", "slate", "owner's account, no scopes", icons=("github",)))
v2.append(box(A, 226, "Claude · ChatGPT", "MCP clients", "slate", "web and phone", icons=("claude", "chat")))
v2.append(box(A, 330, "Claude Code", "MCP client", "slate", "on the Mac", icons=("terminal",)))
v2.append(box(B, 226, "Worker", "OAuth · MCP tools · admin", "indigo", icons=("workers",)))
v2.append(box(B, 420, "RepoWriter", "Durable Object · 1 per repo", "purple", "in-memory mutex, retries", icons=("lock",)))
v2.append(box(B, 600, "Workflow", "reconcile · daily", "orange", "snapshots notes + manifest", icons=("workflow",)))
v2.append(box(Cx, 120, "KV", "OAuth grants", "slate", "hashed tokens", icons=("key",)))
v2.append(box(Cx, 420, "Artifacts", "repo notes · Git", "green", "source of truth", icons=("branch",)))
v2.append(box(Cx, 600, "Queue", "index-jobs + DLQ", "orange", "the only index writer", icons=("queue",)))
v2.append(box(D, 226, "Vectorize", "semantic index", "teal", w=210, icons=("search",)))
v2.append(box(D, 420, "D1", "manifest · FTS5 · alerts", "red", w=210, icons=("database",)))
v2.append(box(D, 600, "Workers AI", "bge-m3", "teal", w=210, icons=("sparkles",)))
# into the Worker
v2.append(arrow([(260, 252), (420, 252)], "OAuth"))
v2.append(arrow([(260, 362), (300, 362), (300, 282), (420, 282)], "OAuth"))
v2.append(arrow([(260, 142), (370, 142), (370, 234), (420, 234)], "sign in", at=0.45))
# from the Worker
v2.append(arrow([(600, 226), (600, 152), (800, 152)], "grants", at=0.5))
v2.append(arrow([(640, 258), (1165, 258), (1165, 436), (1180, 436)]))
v2.append(arrow([(640, 258), (1180, 258)], "search", at=0.62))
v2.append(arrow([(640, 272), (720, 272), (720, 436), (800, 436)], "read", at=0.6))
v2.append(arrow([(640, 284), (660, 284), (660, 614), (800, 614)], "enqueue", at=0.15))
v2.append(arrow([(530, 290), (530, 420)], "operations"))
# writes, events, indexing
v2.append(arrow([(640, 452), (800, 452)], "git push"))
v2.append(arrow([(990, 484), (990, 600)], "pushed event"))
v2.append(arrow([(640, 632), (800, 632)], "fixes"))
v2.append(arrow([(1020, 632), (1180, 632)], "embed"))
v2.append(arrow([(1020, 614), (1110, 614), (1110, 452), (1180, 452)], "record", at=0.5))
v2.append(arrow([(1020, 604), (1140, 604), (1140, 270), (1180, 270)], "upsert", at=0.75))
open(os.path.join(os.path.dirname(__file__), "v2.svg"), "w").write(svg(1460, 770, "Second Brain MCP · v2", "Notes in Cloudflare Artifacts, one writer per repository, one index writer, OAuth with GitHub sign-in.", "".join(v2)))
print("ok")
