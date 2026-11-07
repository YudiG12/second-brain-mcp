"""Writes the README images' sources: banner.html and hld.html, each with a light and a dark theme
(?theme=dark). Render each to PNG at 2x (any headless browser); README picks the theme with <picture>.
Style: the author's brand book (navy + sand, 1px borders, 4px corners, Onest / Oxanium)."""
import json, os
D = os.path.dirname(os.path.abspath(__file__))
B = json.load(open(os.path.join(D, "..", "architecture", "brands.json")))
L = {
 "phone": '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
 "branch": '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
 "sparkles": '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>',
 "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
 "terminal": '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
 "chat": '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
 "file": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8M16 17H8M16 13h-2"/>',
}
def ic(n, c, z):
    if n in B: return f'<svg viewBox="0 0 24 24" width="{z}" height="{z}"><path d="{B[n]}" fill="{c}"/></svg>'
    return f'<svg viewBox="0 0 24 24" width="{z}" height="{z}" fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{L[n]}</svg>'
HEAD = '''<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&family=Oxanium:wght@600&display=swap" rel="stylesheet">
<script>if (location.search.includes("theme=dark")) document.documentElement.dataset.theme = "dark";</script>
<style>
:root{--bg:#FFFFFF;--line:#E3E8ED;--line2:#CBD3DB;--ink:#1B2632;--muted:#4A5D72;--subtle:#677A8E;--arrow:#677A8E;
 --sand-bg:#FCFAF7;--sand-line:#E6D5C1;--sand-ink:#5B4630;--sand:#8A6A3F;--git:#B8A58E;
 --tag-bg:#FEF3EA;--tag-line:#F8CFAE;--tag:#B4530C;--bezel:#1B2632;--screen:#E8EEF4;--bar:#CBD3DB;--base:#C3CBD3}
[data-theme=dark]{--bg:#0D1117;--line:#30363D;--line2:#3D4752;--ink:#F0F3F6;--muted:#B6C1CC;--subtle:#8E9DAD;--arrow:#8E9DAD;
 --sand-bg:#1A1712;--sand-line:#5B4630;--sand-ink:#E6D5C1;--sand:#C9A77F;--git:#8A6A3F;
 --tag-bg:#2A170A;--tag-line:#7A3D10;--tag:#F6A25E;--bezel:#4A5866;--screen:#E8EEF4;--bar:#CBD3DB;--base:#8E9DAD}
*{box-sizing:border-box;margin:0}body{background:var(--bg);font-family:Onest,sans-serif;color:var(--ink)}
.eb{font-family:Oxanium;font-weight:600;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--subtle)}
.tile{display:flex;align-items:center;justify-content:center;border-radius:4px;flex:none}
.nm{position:absolute;width:200px;text-align:center;font-weight:700;font-size:17px;color:var(--ink);letter-spacing:-.01em}
</style></head><body>'''
def tile(n, c, s, i): return f'<div class="tile" style="width:{s}px;height:{s}px;background:color-mix(in srgb,{c} 14%,var(--bg))">{ic(n, c, i)}</div>'

# ---------- banner 1280 x 300 ----------
cl = [("claude", "#D97757", "Claude"), ("chat", "#0E9AA7", "ChatGPT"), ("terminal", "var(--ink)", "Claude Code"), ("apple", "var(--ink)", "Mac")]
rows = "".join(f'<div style="display:flex;align-items:center;gap:12px">{tile(n, c, 40, 20)}<span style="font-weight:600;font-size:16px">{l}</span></div>' for n, c, l in cl)
tags = "".join(f'<span style="font-size:13px;font-weight:600;padding:4px 9px;border-radius:4px;background:var(--tag-bg);color:var(--tag);border:1px solid var(--tag-line)">{t}</span>' for t in ["Workers", "Artifacts", "Durable Objects", "Queues", "Vectorize", "OAuth 2.1"])
banner = HEAD + f'''<div style="width:1280px;height:300px;position:relative;border:1px solid var(--line);border-radius:4px;background:var(--bg);overflow:hidden">
<div style="position:absolute;left:64px;top:54px;width:660px">
 <div style="font-weight:800;font-size:62px;line-height:1.02;letter-spacing:-.03em">Second Brain MCP</div>
 <div style="font-size:21px;color:var(--muted);margin-top:14px;line-height:1.35">Your Markdown notes in every AI client,<br>with keyword and semantic search.</div>
 <div style="display:flex;gap:8px;margin-top:22px;align-items:center">{ic("cloudflare", "#F38020", 26)}{tags}</div>
</div>
<div style="position:absolute;left:770px;top:48px;display:flex;flex-direction:column;gap:12px">{rows}</div>
<svg style="position:absolute;left:928px;top:48px" width="110" height="204" fill="none" stroke="var(--line2)" stroke-width="1.5">
 <path d="M8 20 C64 20 54 102 104 102"/><path d="M8 72 C64 72 54 102 104 102"/><path d="M8 124 C64 124 54 102 104 102"/><path d="M8 176 C64 176 54 102 104 102"/></svg>
<div style="position:absolute;left:1036px;top:84px;width:180px;height:134px;border:1px solid var(--sand-line);background:var(--sand-bg);border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">
 {tile("file", "#B08A5A", 50, 26)}<div style="font-weight:700;color:var(--sand-ink);font-size:16px">One set of notes</div>
 <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--sand)">{ic("cloudflare", "#F38020", 15)}on Cloudflare</div></div>
</div></body></html>'''
open(os.path.join(D, "banner.html"), "w").write(banner)

# ---------- high-level design 1200 x 500 ----------
def sq(cx, cy, n, c, name, s=104):
    return (f'<div style="position:absolute;left:{cx-s/2}px;top:{cy-s/2}px;width:{s}px;height:{s}px;border:1px solid var(--line2);border-radius:4px;background:color-mix(in srgb,{c} 12%,var(--bg));display:flex;align-items:center;justify-content:center">{ic(n, c, 50)}</div>'
            f'<div class="nm" style="left:{cx-100}px;top:{cy+s/2+12}px">{name}</div>')
mac = '''<svg width="170" height="112" viewBox="0 0 170 112"><rect x="22" y="4" width="126" height="84" rx="6" fill="var(--bezel)"/><rect x="28" y="10" width="114" height="72" rx="2" fill="var(--screen)"/>
<rect x="36" y="18" width="46" height="5" rx="1" fill="var(--bar)"/><rect x="36" y="28" width="70" height="4" rx="1" fill="var(--bar)"/><rect x="36" y="36" width="60" height="4" rx="1" fill="var(--bar)"/><rect x="36" y="44" width="66" height="4" rx="1" fill="var(--bar)"/>
<rect x="36" y="56" width="28" height="18" rx="2" fill="#D97757" opacity=".85"/><path d="M4 92 H166 L160 104 Q158 107 154 107 H16 Q12 107 10 104 Z" fill="var(--base)"/><rect x="72" y="92" width="26" height="4" rx="2" fill="var(--bezel)" opacity=".4"/></svg>'''
phone = '''<svg width="70" height="124" viewBox="0 0 70 124"><rect x="2" y="2" width="66" height="120" rx="12" fill="var(--bezel)"/><rect x="7" y="7" width="56" height="110" rx="8" fill="var(--screen)"/>
<rect x="26" y="11" width="18" height="5" rx="2.5" fill="var(--bezel)"/><rect x="14" y="26" width="34" height="5" rx="1" fill="var(--bar)"/><rect x="14" y="36" width="42" height="4" rx="1" fill="var(--bar)"/><rect x="14" y="44" width="38" height="4" rx="1" fill="var(--bar)"/>
<rect x="24" y="62" width="32" height="14" rx="3" fill="#5A4BD1" opacity=".85"/><rect x="14" y="82" width="30" height="12" rx="3" fill="var(--bar)"/><rect x="26" y="108" width="18" height="3" rx="1.5" fill="var(--bar)"/></svg>'''
M = '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill:var(--arrow)"/></marker><marker id="b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill:var(--git)"/></marker></defs>'
hld = HEAD + f'''<div style="width:1200px;height:500px;position:relative;background:var(--bg)">
<div style="position:absolute;left:390px;top:70px;width:780px;height:400px;border:1px dashed var(--line2);border-radius:4px"></div>
<div style="position:absolute;left:408px;top:84px;display:flex;align-items:center;gap:8px" class="eb">{ic("cloudflare", "#F38020", 18)}<span>Cloudflare</span></div>
<svg style="position:absolute;left:0;top:0" width="1200" height="500">{M}
<g fill="none" style="stroke:var(--arrow)" stroke-width="1.8" marker-end="url(#a)">
 <path d="M222 176 H320 V258 H462"/><path d="M172 376 H320 V288 H462"/><path d="M576 258 H690 V170 H742"/><path d="M576 288 H690 V380 H742"/><path d="M856 380 H982"/></g>
<g fill="none" style="stroke:var(--git)" stroke-width="1.8" stroke-dasharray="6 5" marker-end="url(#b)"><path d="M137 118 V36 H794 V112"/></g></svg>
<div style="position:absolute;left:52px;top:120px">{mac}</div><div class="nm" style="left:37px;top:240px">Mac</div>
<div style="position:absolute;left:102px;top:314px">{phone}</div><div class="nm" style="left:37px;top:446px">Any other client</div>
{sq(520, 273, "workers", "#F38020", "Worker")}{sq(800, 165, "branch", "#3FA772", "Artifacts")}{sq(800, 380, "sparkles", "#7B6CF0", "Workers AI")}{sq(1040, 380, "search", "#4F86D6", "Vectorize")}
</div></body></html>'''
open(os.path.join(D, "hld.html"), "w").write(hld)
