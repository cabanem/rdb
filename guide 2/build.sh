#!/usr/bin/env bash
# Build the user guide from guide.md + img/. Run from this folder.
#   ./build.sh   -> dist/guide.docx (upload to Google Docs, or open in Word), dist/guide.pdf,
#                   and dist/guide.html (the interactive version — one self-contained file)
# Re-snip a screenshot? Replace the PNG in img/ (same name), adjust annotate.py if it has callouts, re-run.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
python3 annotate.py
pandoc guide.md -o dist/guide.docx --resource-path=. --toc --toc-depth=1
python3 build_html.py

# PDF: Pandoc + XeLaTeX when a full TeX is installed; otherwise LibreOffice converts the .docx.
if pandoc guide.md -o dist/guide.pdf --resource-path=. --toc --toc-depth=1 \
     --pdf-engine=xelatex -V geometry:margin=1in -V mainfont="DejaVu Sans" -V fontsize=11pt -V colorlinks=true 2>/dev/null; then
  echo "pdf via xelatex"
elif command -v soffice >/dev/null; then
  soffice --headless --convert-to pdf --outdir dist dist/guide.docx >/dev/null
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
