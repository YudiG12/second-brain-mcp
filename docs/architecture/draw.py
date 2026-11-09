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
    "laptop": '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
    "smartphone": '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    "monitor": '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
}

def glyph(name, x, y, size=26, color="#fff"):
    """A white icon at (x, y): a brand mark (filled) or a Lucide icon (stroked)."""
    k = size / 24
    if name in BRANDS:
        return f'<path transform="translate({x},{y}) scale({k})" d="{BRANDS[name]}" fill="{color}"/>'
    return f'<g transform="translate({x},{y}) scale({k})" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{LUCIDE[name]}</g>'

C = dict(indigo="#5B5BD6", purple="#8E6FCB", teal="#3FA796", green="#2F8A5B", red="#D1495B", orange="#E08A3C", slate="#4A5866")
NAVY, MUTED, BG, LINE = "#1B2632", "#4A5D72", "#FCFAF7", "#677A8E"
W, H = 220, 64

def box(x, y, title, sub, color, caption=None, w=W, icons=(), kind="service"):
    """kind: service = managed resource (solid); part = a class inside the Worker (outlined); api = no resource, only called (dashed)."""
    ink = "#fff" if kind == "service" else C[color]
    if kind == "service":
        t = f'<rect x="{x}" y="{y}" width="{w}" height="{H}" rx="6" fill="{C[color]}"/>'
    elif kind == "part":
        t = f'<rect x="{x}" y="{y}" width="{w}" height="{H}" rx="6" fill="#fff" stroke="{C[color]}" stroke-width="2"/>'
    else:
        t = f'<rect x="{x}" y="{y}" width="{w}" height="{H}" rx="6" fill="#fff" stroke="{C[color]}" stroke-width="2" stroke-dasharray="5 4"/>'
    # icons on the left; text centred in the space that's left
    for i, name in enumerate(icons):
        t += glyph(name, x + 14 + i * 32, y + 19, color=ink)
    left = x + (14 + 32 * len(icons) if icons else 0)
    cx = left + (x + w - left) / 2
    t += f'<text x="{cx}" y="{y + 27}" text-anchor="middle" class="t" style="fill:{ink}">{html.escape(title)}</text>'
    t += f'<text x="{cx}" y="{y + 47}" text-anchor="middle" class="s" style="fill:{ink}">{html.escape(sub)}</text>'
    if caption:
        t += f'<text x="{x + w/2}" y="{y + H + 18}" text-anchor="middle" class="c">{html.escape(caption)}</text>'
    return t

def devices(cx, y, names, label):
    """A caption with small device icons before it, centred under a box."""
    tw = 6.6 * len(label); iw = 20 * len(names); x = cx - (iw + 6 + tw) / 2
    t = "".join(f'<g transform="translate({x + i*20},{y - 13}) scale(0.67)" fill="none" stroke="{MUTED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{LUCIDE[n]}</g>' for i, n in enumerate(names))
    return t + f'<text x="{x + iw + 6}" y="{y}" class="c">{html.escape(label)}</text>'

FLOW = dict(auth=LINE, write="#5B5BD6", index="#E08A3C", read="#2F8A5B")
FLOW_MARKERS = "".join(f'<marker id="m-{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{v}"/></marker>' for k, v in FLOW.items())

def legend(x, y, items):
    """Flow names: a short coloured line and its name, in a row."""
    t = ""
    for k, name in items:
        t += f'<path d="M{x},{y} L{x+28},{y}" class="a" style="stroke:{FLOW[k]};stroke-width:2.2"/><text x="{x+36}" y="{y+4}" class="lg">{html.escape(name)}</text>'
        x += 50 + 7.4 * len(name)
    return t

def arrow(points, label=None, at=0.5, both=False, flow=None, dy=0):
    d = "M" + " L".join(f"{x},{y}" for x, y in points)
    style = f' style="stroke:{FLOW[flow]};stroke-width:2.2"' if flow else ""
    end = f"m-{flow}" if flow else "m"
    t = f'<path d="{d}" class="a"{style} marker-end="url(#{end})"{" marker-start=\"url(#ms)\"" if both else ""}/>'
    if label:
        # label on the longest segment
        segs = list(zip(points, points[1:]))
        (x1, y1), (x2, y2) = max(segs, key=lambda s: abs(s[1][0]-s[0][0]) + abs(s[1][1]-s[0][1]))
        lx, ly = x1 + (x2 - x1) * at, y1 + (y2 - y1) * at + dy  # dy: lift the pill off a short arrow
        w = 7.2 * len(label) + 16
        t += f'<rect x="{lx - w/2}" y="{ly - 11}" width="{w}" height="22" rx="11" fill="{FLOW[flow] if flow else NAVY}"/>'
        t += f'<text x="{lx}" y="{ly + 4}" text-anchor="middle" class="p">{html.escape(label)}</text>'
    return t

def svg(width, height, title, subtitle, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" font-family="Onest, Inter, system-ui, sans-serif">
<defs>
<marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>
{FLOW_MARKERS}
<marker id="ms" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>
<style>.t{{fill:#fff;font-size:15px;font-weight:700}}.s{{fill:#fff;font-size:12px;opacity:.92}}.c{{fill:{MUTED};font-size:12px}}
.a{{fill:none;stroke:{LINE};stroke-width:1.6;stroke-dasharray:6 5}}.p{{fill:#fff;font-size:11.5px;font-weight:600}}
.h{{fill:{NAVY};font-size:22px;font-weight:800}}.hs{{fill:{MUTED};font-size:13px}}.g{{fill:none;stroke:#E6D5C1;stroke-width:1.5;stroke-dasharray:2 4}}.gl{{fill:#8C6A43;font-size:12px;font-weight:600}}.lg{{fill:{NAVY};font-size:13px;font-weight:600}}.ft{{font-size:12px;font-weight:700;letter-spacing:.06em}}</style>
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
A, X1, X2, X3 = 40, 440, 800, 1160
# Read it like text, left to right, row by row:
#   row 1, the write: Worker -> RepoWriter -> Artifacts
#   row 2, indexing in the background: Workflow (daily repair) -> Queue
#   row 3, the indexes: D1, Workers AI (embeddings), Vectorize
v2 = []
v2.append('<rect x="400" y="80" width="1020" height="760" rx="10" class="g"/>' + f'<path transform="translate(414,86) scale(0.75)" d="{BRANDS["cloudflare"]}" fill="#F38020"/>' + '<text x="438" y="100" class="gl">CLOUDFLARE</text>')
# GitHub is only the identity provider: its own group, apart from the MCP clients
v2.append('<rect x="24" y="92" width="252" height="128" rx="10" class="g"/><text x="38" y="112" class="gl">SIGN-IN PROVIDER</text>')
v2.append(box(A, 124, "GitHub", "identity only", "slate", "owner's account, no scopes", icons=("github",)))
v2.append('<rect x="24" y="236" width="252" height="236" rx="10" class="g"/><text x="38" y="256" class="gl">MCP CLIENTS</text>')
v2.append(box(A, 260, "Claude · ChatGPT", "MCP clients", "slate", icons=("claude", "chat")) + devices(A + 110, 342, ("monitor", "smartphone"), "Mac (web) and phone"))
v2.append(box(A, 376, "Claude Code", "MCP client", "slate", icons=("terminal",)) + devices(A + 110, 458, ("laptop",), "on the MacBook"))
v2.append(box(X1, 110, "KV", "OAuth grants", "slate", icons=("key",)))
# The Worker is one deployable; the Durable Object and the Workflow are classes inside it, created by its deploy.
v2.append('<path d="M424,232 H1036 V336 H690 V572 H424 Z" fill="#5B5BD6" fill-opacity="0.05" stroke="#5B5BD6" stroke-width="1.5" stroke-dasharray="6 4" rx="8"/>'
          '<text x="436" y="564" class="gl" fill="#5B5BD6" style="fill:#5B5BD6">WORKER · second-brain-mcp</text>')
# row 1
v2.append(box(X1, 250, "MCP endpoint", "OAuth · tools · admin", "indigo", icons=("workers",), kind="part"))
v2.append(box(X2, 250, "RepoWriter", "Durable Object · single writer", "purple", icons=("lock",), kind="part"))
v2.append(box(X3, 250, "Artifacts", "Git · source of truth", "green", icons=("branch",)))
# row 2
v2.append(box(X1, 480, "Reconcile", "Workflow · runs daily", "orange", icons=("workflow",), kind="part"))
v2.append(box(X2, 480, "Queue", "index-jobs + DLQ", "orange", icons=("queue",)))
# row 3
v2.append(box(X1, 700, "D1", "manifest · keyword index", "red", icons=("database",)))
v2.append(box(X2, 700, "Workers AI", "model API · bge-m3", "teal", icons=("sparkles",), kind="api"))
v2.append(box(X3, 700, "Vectorize", "semantic index", "teal", icons=("search",)))
# flows: colour says which one; the name is said once, not on every arrow
ft = lambda x, y, k, name: f'<text x="{x}" y="{y}" class="ft" fill="{FLOW[k]}">{html.escape(name)}</text>'
# sign-in and MCP calls: the three clients bend at the same x and enter the Worker evenly spaced
lk = lambda x, kind, c, name: (f'<rect x="{x}" y="812" width="22" height="14" rx="3" fill="{c if kind=="service" else "#fff"}" stroke="{c}" stroke-width="1.6"{" stroke-dasharray=\"4 3\"" if kind=="api" else ""}/>' f'<text x="{x+30}" y="824" class="c">{name}</text>')
v2.append(lk(440, "service", C["green"], "managed service (its own resource)") + lk(720, "part", C["purple"], "part of the Worker (your code)") + lk(960, "api", C["teal"], "API, called only"))
v2.append(arrow([(260, 156), (340, 156), (340, 258), (440, 258)], flow="auth"))
v2.append(arrow([(260, 292), (440, 292)], "MCP + OAuth", at=0.38, flow="auth"))
v2.append(arrow([(260, 408), (340, 408), (340, 306), (440, 306)], flow="auth"))
v2.append(arrow([(550, 250), (550, 174)], flow="auth"))
# write the note: Worker -> RepoWriter -> Artifacts
v2.append(arrow([(660, 282), (800, 282)], flow="write"))
v2.append(arrow([(1020, 282), (1160, 282)], flow="write"))
v2.append(arrow([(660, 282), (800, 282)], "write the note", flow="write", dy=-22))
# index it: into the Queue, then the consumer writes the indexes
v2.append(arrow([(620, 314), (620, 430), (860, 430), (860, 480)], flow="index"))
v2.append(arrow([(1270, 314), (1270, 430), (960, 430), (960, 480)], "index in the background", flow="index"))
v2.append(arrow([(660, 512), (800, 512)], flow="index"))
v2.append(arrow([(660, 512), (800, 512)], "reconciliation", flow="index", dy=-22))
v2.append(arrow([(840, 544), (840, 620), (550, 620), (550, 700)], flow="index"))
v2.append(arrow([(910, 544), (910, 700)], flow="index"))
v2.append(arrow([(980, 544), (980, 620), (1270, 620), (1270, 700)], "write embeddings", flow="index"))
# read and search
v2.append(arrow([(620, 250), (620, 214), (1240, 214), (1240, 250)], "read a note", at=0.5, flow="read"))
v2.append(arrow([(440, 274), (418, 274), (418, 732), (440, 732)], flow="read"))
v2.append(arrow([(418, 732), (418, 800), (1270, 800), (1270, 764)], "search", flow="read"))

open(os.path.join(os.path.dirname(__file__), "v2.svg"), "w").write(svg(1460, 860, "Second Brain MCP · v2", "Notes in Cloudflare Artifacts, one writer per repository, one index writer, OAuth with GitHub sign-in.", "".join(v2)))
print("ok")
