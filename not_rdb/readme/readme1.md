# Maintaining the Contract Intake user guide

This folder is the user guide's source. One Markdown file and a handful of screenshots go in; a PDF, a Word
file and an interactive web page come out, and the web page is published to an Apps Script web app that the
dashboard links to. Nothing in the outputs is edited by hand — if something looks wrong in the PDF, fix the
source and rebuild.

```
docs/
├── guide.md             the guide — every word of it
├── img/                 the screenshots, numbered in reading order
├── annotate.py          where the numbered badges go on the overview screenshot
├── build_html.py        turns guide.md + annotate.py into the interactive page
├── build.sh             runs everything, in order
├── gas/                 the Apps Script web app that serves the interactive page
├── requirements.txt     Pillow — the only Python dependency
└── dist/                outputs (generated; not committed)
```

## Everyday changes

### Change some wording

Edit `guide.md`. Run `./build.sh`. Done — the change is in all three outputs and, if publishing is set up,
on the live page.

`guide.md` is ordinary Pandoc Markdown with a YAML block at the top for the title, subtitle and date. Each
`#` heading is a section in the PDF and a tab on the interactive page, so add or rename sections there.
Images are referenced as `![caption](img/NN-name.png)`; append `{width=55%}` to shrink a tall screenshot on
the printed page (the interactive page reads the same hint).

### Replace a screenshot

Snip the screen, save it over the existing PNG in `img/` under the **same name**, run `./build.sh`. The name
is the only link between the picture and the guide, so keeping it means nothing else changes.

If the new screenshot is the overview (`01-dashboard.png`) and anything moved on it, re-place the badges —
see *The numbered badges* below. For every other screenshot there is nothing further to do.

### Add a screenshot

1. Save it as `img/NN-short-name.png`, with `NN` placing it in reading order after the one it follows.
2. Add an image line in `guide.md` where it belongs, with a caption.
3. `./build.sh`.

The review-sheet screenshot is still missing: save it as `img/07-review-sheet.png` and uncomment the image
line in the *Reviewing a contract* section.

### Add or move a numbered badge

Two things must agree: the coordinate list in `annotate.py` and the numbered paragraphs in the
*Reading the page* section of `guide.md`.

In `annotate.py`, the `CALLOUTS` dict holds `(number, x, y)` triples in pixel coordinates of the clean
screenshot. Add or edit a triple there. The badge is drawn at that point, so put it in whitespace next to the
thing it labels, not on top of its text.

In `guide.md`, each badge needs a paragraph that starts `**N — Title.**` (any dash will do). Whatever follows
that paragraph up to the next numbered one — a table, a figure — travels with it on the interactive page.

If the two lists disagree, the build stops and prints both, e.g.

```
Badge numbers disagree.
  annotate.py CALLOUTS has: [1, 2, 3, 4, 5, 6, 7, 8, 9]
  guide.md "Reading the page" has: [1, 2, 3, 4, 5, 6, 8, 9]
```

That message says which side to fix.

## The build

`./build.sh` from this folder does, in order:

1. Finds Python, Pandoc and (optionally) LibreOffice. It prefers a `.venv` here, then whatever is on PATH,
   then the standard Windows install folders. Any of them can be pointed at explicitly:
   `PANDOC=/c/path/to/pandoc.exe ./build.sh`, likewise `SOFFICE=…`.
2. Runs `annotate.py` → `img/01-dashboard-annotated.png` (the badged overview used by the PDF and Word file).
3. Pandoc: `guide.md` → `dist/guide.docx`.
4. `build_html.py`: `guide.md` + `annotate.py` + `img/` → `dist/guide.html`, one self-contained file with the
   screenshots inlined.
5. Pandoc + XeLaTeX → `dist/guide.pdf`, or LibreOffice converting the `.docx` if there is no TeX, or a note
   that there is no PDF engine (the `.docx` opens in Google Docs, which can export a PDF).
6. If `gas/.clasp.json` exists and `clasp` is installed: copies `dist/guide.html` into `gas/` and pushes. If
   `DEPLOY_ID` is set, also updates the web app deployment so the live link shows the new version.

Steps 1–5 need nothing but the tools; step 6 is what makes the guide live. To iterate on the interactive
page alone, `python build_html.py` is faster and skips the PDF and the push.

### First-time setup on a machine

```bash
pandoc --version                           # install: winget install JohnMacFarlane.Pandoc  (pandoc.org otherwise)
python -m venv .venv                       # optional but tidy
.venv/Scripts/python -m pip install -r requirements.txt     # Windows; .venv/bin/python on mac/Linux
npm i -g @google/clasp && clasp login      # only needed to publish
```

Then `./build.sh`. With no `gas/.clasp.json` yet, the publish step is skipped, which is the right first run.

For publishing, follow `gas/README.md` once: create the Apps Script project, put its Script ID in
`gas/.clasp.json`, push, make the first deployment in the editor (Execute as Me, Anyone in the org), and put
its Deployment ID in `DEPLOY_ID` — exported in your shell or set at the top of `build.sh`. Every later
`./build.sh` updates that same deployment; the link colleagues have never changes.

## Where things live and why

- **The dashboard finds the guide through Config.** The `guide_url` key (Settings drawer → Dashboard → *User
  guide URL*) holds the web app's `/exec` link and puts a *Guide* button in the dashboard header. Moving the
  guide is a Settings change, not a code change.
- **The guide's web app is its own deployment.** Rebuilding the guide never touches the dashboard, and
  vice versa.
- **`gas/` is excluded from the host's `clasp push`** by the `.claspignore` at the host project root. Without
  that line the host would upload `gas/Code.js` into the dashboard project and gain a second `doGet`. If the
  dashboard ever starts serving the guide instead of itself, this is why.
- **Only authored inputs are committed.** `.gitignore` here excludes `dist/`, `gas/guide.html`, the
  annotated PNG, the venv and `gas/.clasp.json` (which holds the script id). A fresh clone plus `./build.sh`
  reproduces every output.

## If the build fails

| Message | Cause | Fix |
|---|---|---|
| `python3: command not found` | an old `build.sh` | replace it; the current one finds `python`, `py` or the venv |
| `pandoc not found` | not installed, or not on PATH | install it, or `PANDOC=/c/…/pandoc.exe ./build.sh` |
| `Pillow is missing` | first run on a machine | `python -m pip install -r requirements.txt` |
| `UnicodeDecodeError … charmap` | an old `build_html.py` on Windows | replace it; the current one pins UTF-8 |
| `Badge numbers disagree` | `annotate.py` and `guide.md` list different badges | the message shows both lists |
| `no PDF engine found` | no TeX and no LibreOffice | the `.docx` still built; export PDF from Google Docs, or install LibreOffice |
| the live page didn't change | pushed but not deployed | set `DEPLOY_ID`; a push alone only updates the `/dev` URL |

The last one is the same rule as for the dashboard: `clasp push` updates code, a *deployment* is what readers
see.

## Changing the look

The interactive page's colours and fonts are CSS variables at the top of the `<style>` block in
`build_html.py`. They are copied from the dashboard's `:root` in `Dashboard.html` so the two match; if the
dashboard's palette changes, change these to follow. `--bg` is the page, `--surface` the cards and the white
mats around screenshots, `--shadow` their depth. The page is light-only, like the dashboard; a
`data-theme="dark"` attribute on `<html>` is the one switch kept for later.

The PDF's look is Pandoc's defaults plus the flags in `build.sh` (margins, font, link colour). A reference
`.docx` can be passed with `--reference-doc` if a house Word style is ever wanted.
