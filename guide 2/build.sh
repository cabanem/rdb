#!/usr/bin/env bash
# Build the user guide from guide.md + img/. Run from this folder.
#   ./build.sh                               -> dist/guide.docx (upload to Google Docs, or open in Word), dist/guide.pdf,
#                   and dist/guide.html (the interactive version — one self-contained file)
#   PANDOC=/c/some/where/pandoc.exe ./build.sh   if pandoc is not on PATH (SOFFICE=... likewise)
# Re-snip a screenshot? Replace the PNG in img/ (same name), adjust annotate.py if it has callouts, re-run.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

# Find a Python. Prefer the venv here (Linux/mac layout, then Windows layout); otherwise whatever the
# machine calls it — Windows installs `python` or the `py` launcher, not `python3`.
if   [ -x .venv/bin/python ];        then PY=.venv/bin/python
elif [ -x .venv/Scripts/python.exe ]; then PY=.venv/Scripts/python.exe
elif command -v python3 >/dev/null;  then PY=python3
elif command -v python  >/dev/null;  then PY=python
elif command -v py      >/dev/null;  then PY="py -3"
else echo "No Python found. Install it or create the venv (see step 3)." >&2; exit 1
fi
$PY -c "import PIL" 2>/dev/null || { echo "Pillow is missing: $PY -m pip install -r requirements.txt" >&2; exit 1; }

# Find pandoc. Override with PANDOC=/path/to/pandoc.exe ./build.sh; otherwise PATH, then the usual Windows spots.
if [ -z "${PANDOC:-}" ]; then
  for c in pandoc "${LOCALAPPDATA:-}/Pandoc/pandoc.exe" "/c/Program Files/Pandoc/pandoc.exe" "$HOME/AppData/Local/Pandoc/pandoc.exe"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PANDOC="$c"; break; fi
  done
fi
{ [ -n "${PANDOC:-}" ] && command -v "$PANDOC" >/dev/null 2>&1; } || \
  { echo "pandoc not found${PANDOC:+ at $PANDOC}. Install it, or run: PANDOC=/path/to/pandoc.exe ./build.sh" >&2; exit 1; }

# Find LibreOffice the same way (only needed for the PDF when there is no TeX). SOFFICE=/path overrides.
if [ -z "${SOFFICE:-}" ]; then
  for c in soffice "/c/Program Files/LibreOffice/program/soffice.exe" "/Applications/LibreOffice.app/Contents/MacOS/soffice"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then SOFFICE="$c"; break; fi
  done
fi

$PY annotate.py
"$PANDOC" guide.md -o dist/guide.docx --resource-path=. --toc --toc-depth=1
$PY build_html.py

# PDF: Pandoc + XeLaTeX when a full TeX is installed; otherwise LibreOffice converts the .docx.
if "$PANDOC" guide.md -o dist/guide.pdf --resource-path=. --toc --toc-depth=1 \
     --pdf-engine=xelatex -V geometry:margin=1in -V mainfont="DejaVu Sans" -V fontsize=11pt -V colorlinks=true 2>/dev/null; then
  echo "pdf via xelatex"
elif [ -n "${SOFFICE:-}" ]; then
  "$SOFFICE" --headless --convert-to pdf --outdir dist dist/guide.docx >/dev/null
  echo "pdf via LibreOffice"
else
  echo "no PDF engine found; open dist/guide.docx in Google Docs and use File > Download > PDF"
fi
echo "built: $(ls dist)"

# ---- optional: publish to the Apps Script web app (see gas/README.md for the one-time setup) ----
DEPLOY_ID="${DEPLOY_ID:-}"          # export DEPLOY_ID=AKfycb... or set it here
if [ -f gas/.clasp.json ] && command -v clasp >/dev/null; then
  cp dist/guide.html gas/guide.html
  (cd gas && clasp push -f)
  if [ -n "$DEPLOY_ID" ]; then
    (cd gas && clasp deploy -i "$DEPLOY_ID" -d "guide $(date +%F)")
    echo "published to the existing web app deployment"
  else
    echo "pushed; set DEPLOY_ID to also update the /exec deployment (or test at the /dev URL)"
  fi
fi
