"""Build dist/guide.html — the interactive version of the guide — from the SAME sources as the PDF:
   guide.md      every word, via pandoc
   annotate.py   the badge coordinates, which here become clickable hotspots
   img/          the screenshots, inlined as data URIs so the page is one self-contained file

Sections (H1) become tabs. In "Reading the page", each paragraph that starts "**N — Title.**" becomes the
panel shown when hotspot N is clicked; anything that follows it up to the next numbered paragraph (the tiles
table, a figure) travels with it. Run: python3 build_html.py   (build.sh calls it)
"""
import base64, html, json, os, re, shutil, subprocess, sys
from annotate import CALLOUTS
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

# Pandoc: whatever build.sh resolved (exported as PANDOC), else PATH, else the usual Windows install folders.
PANDOC = os.environ.get('PANDOC') or shutil.which('pandoc') or next(
    (c for c in [os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Pandoc', 'pandoc.exe'),
                 r'C:\Program Files\Pandoc\pandoc.exe'] if os.path.isfile(c)), None)
if not PANDOC or not (shutil.which(PANDOC) or os.path.isfile(PANDOC)):
    sys.exit('pandoc not found%s. Install it or run: PANDOC=/path/to/pandoc.exe ./build.sh' % (' at ' + PANDOC if PANDOC else ''))

# ---- 1. guide.md -> HTML sections ------------------------------------------------------------
raw = subprocess.check_output([PANDOC, 'guide.md', '-t', 'html', '--section-divs'], text=True)
def front(key):   # YAML front matter, one line per key, quoted or not
    m = re.search(r'^%s:\s*"?(.*?)"?\s*$' % key, open('guide.md').read().split('---')[1], re.M)
    return m.group(1) if m else ''
TITLE, SUBTITLE, DATE = front('title'), front('subtitle'), front('date')

def data_uri(path):
    with open(path, 'rb') as f:
        return 'data:image/png;base64,' + base64.b64encode(f.read()).decode()

def inline_images(h):
    # width attributes from {width=55%} become a class; the CSS decides real sizes per breakpoint
    h = re.sub(r'<img src="([^"]+)"([^>]*?) style="width:(\d+)%[^"]*"', lambda m: '<img src="%s"%s class="w%s"' % (data_uri(m.group(1)), m.group(2), m.group(3)), h)
    h = re.sub(r'<img src="(img/[^"]+)"', lambda m: '<img src="%s"' % data_uri(m.group(1)), h)
    return h

sections = []
for m in re.finditer(r'<section id="([^"]+)" class="level1">\s*<h1>(.*?)</h1>(.*?)</section>', raw, re.S):
    sections.append({'id': m.group(1), 'title': m.group(2), 'body': m.group(3).strip()})

# ---- 2. hotspots: numbered paragraphs in "Reading the page" ---------------------------------
reading = next(s for s in sections if s['id'] == 'reading-the-page')
overview = next(s for s in sections if s['id'] == 'what-this-page-is')
chunks = re.split(r'(?=<p><strong>\d+ — )', reading['body'])
intro = chunks[0].strip()
hotspots = []
for c in chunks[1:]:
    mm = re.match(r'<p><strong>(\d+) — (.*?)\.?</strong>\s*(.*?)</p>(.*)', c, re.S)
    n, title, first, rest = int(mm.group(1)), mm.group(2), mm.group(3).strip(), mm.group(4).strip()
    body = ('<p>%s</p>' % first if first else '') + rest
    hotspots.append({'n': n, 'title': title, 'body': body})

# coordinates as percentages of the CLEAN screenshot (badges are drawn by the page, not baked in)
clean_src, (_, marks) = next(iter(CALLOUTS.items()))
w, h = Image.open(clean_src).size
for n, x, y in marks:
    hs = next(s for s in hotspots if s['n'] == n)
    hs['x'], hs['y'] = round(max(2.6, 100 * x / w), 2), round(100 * y / h, 2)   # keep a margin badge inside the frame
overview_img = data_uri(clean_src)
overview_body = re.sub(r'<figure>.*?</figure>', '', overview['body'], flags=re.S).strip()   # the annotated figure is replaced by the live one

tabs = [s for s in sections if s['id'] not in ('what-this-page-is', 'reading-the-page')]

# ---- 3. the page ------------------------------------------------------------------------------
def esc(s): return html.escape(s, quote=True)

hot_html = ''.join(
    '<button class="hot" type="button" data-n="%d" style="left:%s%%;top:%s%%" aria-label="%s">%d</button>'
    % (s['n'], s['x'], s['y'], esc('%d: %s' % (s['n'], s['title'])), s['n']) for s in hotspots)
panel_html = ''.join(
    '<article class="hs" id="hs-%d" hidden><h3><span class="badge">%d</span>%s</h3>%s</article>'
    % (s['n'], s['n'], esc(s['title']), inline_images(s['body'])) for s in hotspots)
nav_html = '<button class="tab" type="button" data-tab="explore" aria-selected="true">The page</button>' + ''.join(
    '<button class="tab" type="button" data-tab="%s">%s</button>' % (s['id'], s['title']) for s in tabs)
tabs_html = ''.join(
    '<section class="pane" id="pane-%s" hidden><h2>%s</h2>%s</section>' % (s['id'], s['title'], inline_images(s['body'])) for s in tabs)
order = json.dumps(['explore'] + [s['id'] for s in tabs])

page = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>%(title)s</title>
<style>
  :root {
    box-sizing: border-box;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    --bg: #f6f5f2; --surface: #fff; --ink: #1b1f26; --ink-2: #3b4250; --muted: #6b7280; --line: #e3e4e8;
    --accent: #1c5cab; --accent-ink: #fff; --hot: #d03b3b; --hot-active: #1c5cab; --code: #eef0f3;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg: #15171c; --surface: #1f2229; --ink: #e8eaee; --ink-2: #c5c9d1; --muted: #8b919c; --line: #30343c;
    --accent: #7fb0ec; --accent-ink: #0f1a2a; --hot: #e0605f; --hot-active: #7fb0ec; --code: #2a2e36;
  } }
  :root[data-theme="dark"] {
    --bg: #15171c; --surface: #1f2229; --ink: #e8eaee; --ink-2: #c5c9d1; --muted: #8b919c; --line: #30343c;
    --accent: #7fb0ec; --accent-ink: #0f1a2a; --hot: #e0605f; --hot-active: #7fb0ec; --code: #2a2e36;
  }
  html { scroll-padding-top: env(safe-area-inset-top, 0px); }
  * { box-sizing: inherit; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 48px; }
  header h1 { margin: 0; font-size: 26px; }
  header p { margin: 4px 0 0; color: var(--muted); }
  nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 20px 0 18px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  .tab { border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); border-radius: 999px; padding: 7px 14px; font: inherit; font-size: 14px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .tab:focus-visible, .hot:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* explore */
  .explore { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 20px; align-items: start; }
  .shot { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .shot img { display: block; width: 100%%; height: auto; }
  .hot { position: absolute; transform: translate(-50%%, -50%%); width: 30px; height: 30px; border-radius: 50%%; border: 2px solid #fff;
         background: var(--hot); color: #fff; font: 700 15px/1 system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); padding: 0;
         transition: transform .12s; }
  .hot:hover { transform: translate(-50%%, -50%%) scale(1.15); }
  .hot[aria-pressed="true"] { background: var(--hot-active); transform: translate(-50%%, -50%%) scale(1.2); }
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; position: sticky; top: calc(12px + env(safe-area-inset-top, 0px)); }
  .panel .hint { color: var(--muted); font-size: 14px; }
  .panel .steps { display: flex; justify-content: space-between; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
  .panel .steps button { border: 1px solid var(--line); background: transparent; color: var(--ink-2); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 14px; cursor: pointer; }
  .panel .steps button[disabled] { opacity: .4; cursor: default; }
  .hs h3 { margin: 0 0 8px; font-size: 17px; display: flex; align-items: center; gap: 10px; }
  .badge { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%%; background: var(--hot-active); color: #fff; font-size: 14px; font-weight: 700; flex: none; }
  .hs p:first-of-type { margin-top: 0; }

  /* prose panes */
  .pane { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 22px 26px; max-width: 860px; }
  .pane h2 { margin: 0 0 12px; font-size: 22px; }
  .pane p, .hs p { margin: 0 0 12px; }
  .pane figure, .hs figure { margin: 16px 0; }
  .pane img, .hs img { max-width: 100%%; height: auto; border: 1px solid var(--line); border-radius: 8px; cursor: zoom-in; display: block; }
  .pane img.w55 { max-width: 55%%; } .pane img.w75 { max-width: 75%%; }
  @media (max-width: 700px) { .pane img.w55, .pane img.w75 { max-width: 100%%; } }
  figcaption { color: var(--muted); font-size: 13px; margin-top: 6px; }
  table { border-collapse: collapse; width: 100%%; font-size: 14px; margin: 8px 0 14px; display: block; overflow-x: auto; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  code { background: var(--code); border-radius: 4px; padding: 1px 5px; font-size: .92em; }
  a { color: var(--accent); }
  .pager { display: flex; justify-content: space-between; margin-top: 18px; max-width: 860px; }
  .pager button { border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); border-radius: 8px; padding: 8px 14px; font: inherit; font-size: 14px; cursor: pointer; }
  .pager button[hidden] { visibility: hidden; display: inline-block; }

  /* lightbox */
  .lb { position: fixed; inset: 0; background: rgba(0,0,0,.82); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 50; cursor: zoom-out; }
  .lb[hidden] { display: none; }
  .lb img { max-width: 100%%; max-height: 100%%; border-radius: 8px; }
  @media (max-width: 860px) { .explore { grid-template-columns: 1fr; } .panel { position: static; } .hot { width: 24px; height: 24px; font-size: 12px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>%(title)s</h1>
    <p>%(subtitle)s</p>
  </header>

  <nav role="tablist" aria-label="Sections">%(nav)s</nav>

  <section class="pane-explore" id="pane-explore">
    %(overview_body)s
    <div class="explore">
      <div class="shot">
        <img src="%(overview_img)s" alt="The Contract Intake dashboard">
        %(hots)s
      </div>
      <aside class="panel" aria-live="polite">
        <div id="panelIntro">
          <p class="hint">Click a number on the screenshot, or press &rarr; to walk through the page in order.</p>
          %(intro)s
        </div>
        %(panels)s
        <div class="steps"><button type="button" id="prevHs">&larr; Previous</button><span class="hint" id="hsPos"></span><button type="button" id="nextHs">Next &rarr;</button></div>
      </aside>
    </div>
  </section>

  %(tabs)s

  <div class="pager"><button type="button" id="prevTab">&larr; Back</button><button type="button" id="nextTab">Next section &rarr;</button></div>
  <p class="hint" style="color:var(--muted);font-size:13px;margin-top:24px">%(date)s. Built from the same source as the printed guide.</p>
</div>
<div class="lb" id="lb" hidden><img id="lbImg" alt=""></div>

<script>
(function () {
  'use strict';
  var ORDER = %(order)s;
  var HS = %(hs_count)d;
  var $ = function (id) { return document.getElementById(id); };
  var current = null;      // hotspot number or null
  var tab = 'explore';

  function remember(k, v) { try { localStorage.setItem('guide:' + k, v); } catch (e) {} }
  function recall(k) { try { return localStorage.getItem('guide:' + k); } catch (e) { return null; } }

  // ---- tabs
  function showTab(id) {
    tab = ORDER.indexOf(id) === -1 ? 'explore' : id;
    document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    $('pane-explore').hidden = tab !== 'explore';
    document.querySelectorAll('.pane').forEach(function (p) { p.hidden = p.id !== 'pane-' + tab; });
    var i = ORDER.indexOf(tab);
    $('prevTab').hidden = i === 0;
    $('nextTab').hidden = i === ORDER.length - 1;
    remember('tab', tab);
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
  $('prevTab').addEventListener('click', function () { showTab(ORDER[ORDER.indexOf(tab) - 1]); });
  $('nextTab').addEventListener('click', function () { showTab(ORDER[ORDER.indexOf(tab) + 1]); });

  // ---- hotspots
  function showHs(n) {
    current = n;
    $('panelIntro').hidden = n != null;
    for (var i = 1; i <= HS; i++) $('hs-' + i).hidden = i !== n;
    document.querySelectorAll('.hot').forEach(function (h) { h.setAttribute('aria-pressed', String(Number(h.dataset.n) === n)); });
    $('prevHs').disabled = n == null;
    $('nextHs').disabled = n === HS;
    $('hsPos').textContent = n == null ? '' : n + ' of ' + HS;
    remember('hs', n == null ? '' : String(n));
  }
  document.querySelectorAll('.hot').forEach(function (h) {
    h.addEventListener('click', function () { showHs(current === Number(h.dataset.n) ? null : Number(h.dataset.n)); });
  });
  $('prevHs').addEventListener('click', function () { showHs(current > 1 ? current - 1 : null); });
  $('nextHs').addEventListener('click', function () { showHs(current == null ? 1 : Math.min(HS, current + 1)); });
  document.addEventListener('keydown', function (e) {
    if (!$('lb').hidden) { if (e.key === 'Escape') closeLb(); return; }
    if (tab !== 'explore' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); $('nextHs').click(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); $('prevHs').click(); }
    if (e.key === 'Escape') showHs(null);
  });

  // ---- lightbox for every screenshot in the prose panes
  function closeLb() { $('lb').hidden = true; $('lbImg').src = ''; }
  document.querySelectorAll('.pane img, .hs img').forEach(function (img) {
    img.addEventListener('click', function () { $('lbImg').src = img.src; $('lbImg').alt = img.alt; $('lb').hidden = false; });
  });
  $('lb').addEventListener('click', closeLb);

  // ---- resume where the reader left off (per browser; a convenience only)
  showTab(recall('tab') || 'explore');
  var hs = Number(recall('hs'));
  showHs(hs >= 1 && hs <= HS ? hs : null);
})();
</script>
</body>
</html>
''' % {
    'title': esc(TITLE), 'subtitle': esc(SUBTITLE), 'date': esc(DATE), 'nav': nav_html,
    'overview_body': overview_body, 'overview_img': overview_img, 'hots': hot_html, 'intro': intro,
    'panels': panel_html, 'tabs': tabs_html, 'order': order, 'hs_count': len(hotspots)
}

os.makedirs('dist', exist_ok=True)
with open('dist/guide.html', 'w') as f:
    f.write(page)
print('wrote dist/guide.html (%d KB, %d hotspots, %d tabs)' % (len(page) // 1024, len(hotspots), len(tabs) + 1))
