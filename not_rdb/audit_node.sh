#!/usr/bin/env bash
# node-vuln-sweep.sh — find every node_modules tree on this machine, say who
# owns it, audit the ones you own, and (optionally) fix them.
#
# Usage (from Git Bash):
#   ./node-vuln-sweep.sh                      # report only, both drives
#   ./node-vuln-sweep.sh --fix                # also apply safe fixes to owned trees
#   ./node-vuln-sweep.sh --pkg lodash         # also list every copy of one package
#   ./node-vuln-sweep.sh --roots "/d/Users/me /c/Users/me"   # narrow the search
#
# "Safe fix" means: npm audit fix (no --force) in your projects, npm update -g
# for globals, npm i -g npm@latest for Node's bundled npm. Trees that belong to
# installed applications or Node version managers are reported, never touched.

set -uo pipefail

FIX=0; PKG=""; ROOTS="/c /d"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fix)   FIX=1 ;;
    --pkg)   PKG="$2"; shift ;;
    --roots) ROOTS="$2"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

REPORT="node-vuln-sweep_$(date +%Y%m%d-%H%M%S).txt"
exec > >(tee "$REPORT") 2>&1
echo "== node-vuln-sweep  $(date)  roots: $ROOTS  fix: $FIX"
echo

# ---- 1. Node runtimes -------------------------------------------------------
echo "== Node runtimes (node.exe)"
while IFS= read -r exe; do
  v=$("$exe" -v 2>/dev/null || echo "?")
  printf '  %-10s %s\n' "$v" "$exe"
done < <(find $ROOTS \( -path '/c/Windows' -o -name '$Recycle.Bin' -o -name 'System Volume Information' \) -prune \
             -o -type f -iname 'node.exe' -print 2>/dev/null | sort)
echo

# ---- 2. Every top-level node_modules tree -----------------------------------
# -prune on node_modules means we list each tree once and never descend into
# nested node_modules; npm handles nesting inside a tree for us.
mapfile -t TREES < <(find $ROOTS \( -path '/c/Windows' -o -name '$Recycle.Bin' -o -name 'System Volume Information' \) -prune \
                          -o -type d -name node_modules -prune -print 2>/dev/null | sort)

classify() {
  case "$1" in
    */nodejs/node_modules)                       echo bundled-npm ;;
    */AppData/Roaming/npm/node_modules)          echo global ;;
    */nvm/*|*/fnm/*|*/[Vv]olta/*|*/.volta/*)     echo version-manager ;;
    "/c/Program Files"*|"/d/Program Files"*|/c/ProgramData/*) echo vendor-app ;;
    */AppData/Local/*|*/.vscode/*|*/.cursor/*)   echo app-bundled ;;
    *)                                           echo project ;;
  esac
}

echo "== node_modules trees (${#TREES[@]} found)"
declare -a PROJECTS=()
for t in "${TREES[@]}"; do
  cls=$(classify "$t")
  printf '  %-16s %s\n' "$cls" "$t"
  [[ $cls == project ]] && PROJECTS+=("${t%/node_modules}")
done
echo

# ---- 3. Audit the projects you own ------------------------------------------
echo "== npm audit on ${#PROJECTS[@]} project(s)"
for root in "${PROJECTS[@]}"; do
  echo "-- $root"
  if [[ ! -f "$root/package.json" ]]; then
    echo "   no package.json — orphaned node_modules; safe to delete"
    continue
  fi
  if [[ ! -f "$root/package-lock.json" ]]; then
    echo "   no package-lock.json — audit needs one (npm i --package-lock-only creates it without installing)"
    continue
  fi
  ( cd "$root" && npm audit --json 2>/dev/null | node -e '
      let d; try { d = JSON.parse(require("fs").readFileSync(0,"utf8")); } catch { console.log("   audit failed (network?)"); process.exit(0); }
      const v = d.metadata.vulnerabilities;
      console.log(`   critical=${v.critical} high=${v.high} moderate=${v.moderate} low=${v.low}`);
      for (const [name, info] of Object.entries(d.vulnerabilities || {}))
        if (["critical","high"].includes(info.severity))
          console.log(`   ${info.severity.padEnd(8)} ${name} ${info.range}${info.fixAvailable ? "" : "  (no fix available)"}`);
    ' )
  if [[ $FIX -eq 1 ]]; then
    echo "   fixing..."
    ( cd "$root" && npm audit fix 2>&1 | tail -n 5 | sed 's/^/   /' )
  fi
done
echo

# ---- 4. Global and bundled npm ----------------------------------------------
echo "== global / bundled"
echo "   npm $(npm -v 2>/dev/null)  node $(node -v 2>/dev/null)  ($(command -v node))"
npm outdated -g 2>/dev/null | sed 's/^/   /'
if [[ $FIX -eq 1 ]]; then
  echo "   npm update -g"; npm update -g 2>&1 | tail -n 3 | sed 's/^/   /'
  echo "   npm install -g npm@latest"; npm install -g npm@latest 2>&1 | tail -n 3 | sed 's/^/   /'
  echo "   npm cache clean --force"; npm cache clean --force 2>/dev/null
fi
echo

# ---- 5. Optional: every copy of one package ---------------------------------
if [[ -n $PKG ]]; then
  echo "== every copy of $PKG"
  find $ROOTS \( -path '/c/Windows' -o -name '$Recycle.Bin' \) -prune \
       -o -type f -path "*/node_modules/$PKG/package.json" -print 2>/dev/null \
    | while IFS= read -r pj; do
        v=$(grep -m1 '"version"' "$pj" | sed -E 's/.*"version": *"([^"]+)".*/\1/')
        printf '  %-12s %s\n' "$v" "${pj%/package.json}"
      done
  echo
fi

echo "== done. report: $REPORT"
echo "   Not touched (report to the owner): vendor-app, app-bundled, version-manager trees above."
