#!/usr/bin/env bash
# node-audit.sh                  find every node.exe, show versions, mark the one `node` actually runs
# node-audit.sh --deep           same, but walk all of C: and D: (slow, thorough)
# node-audit.sh update <ver>     replace the ACTIVE node (plain extracted folder only) with <ver>,
#                                downloaded from nodejs.org and SHA-256 verified. e.g. update 24.22.1
# Git Bash on Windows.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
w2u() { cygpath -u "$1"; }
lc()  { tr '[:upper:]' '[:lower:]'; }

# --- the node that runs when you type `node`: first hit on PATH ---------------
active=""
first=$(where.exe node 2>/dev/null | head -n1 | tr -d '\r' || true)
[ -n "$first" ] && active=$(w2u "$first")

scan() {
  local deep=$1 roots=() r depth=()
  if [ "$deep" = 1 ]; then
    roots=(/c /d)
  else
    for r in "/c/Program Files/nodejs" "/c/Program Files (x86)/nodejs" \
             "$(w2u "${LOCALAPPDATA:-C:/nope}")/Programs" \
             "$(w2u "${APPDATA:-C:/nope}")/nvm" \
             "$(w2u "${LOCALAPPDATA:-C:/nope}")/fnm_multishells" \
             "$(w2u "${LOCALAPPDATA:-C:/nope}")/Volta" \
             "$(w2u "${USERPROFILE:-C:/nope}")" /c/Users /d/Users; do
      [ -d "$r" ] && roots+=("$r")
    done
    depth=(-maxdepth 4)
  fi

  echo "== node.exe on disk  ($([ "$deep" = 1 ] && echo 'deep: all of C: and D:' || echo 'common locations; --deep for everything'))"
  find "${roots[@]}" "${depth[@]}" \( -type d -name node_modules -prune \) -o \
       \( -type f -iname node.exe -print \) 2>/dev/null | sort -u | while IFS= read -r exe; do
    v=$("$exe" --version 2>/dev/null || echo "?")
    mark="  "
    [ -n "$active" ] && [ "$(printf %s "$exe" | lc)" = "$(printf %s "$active" | lc)" ] && mark="* "
    printf '%s%-10s %s\n' "$mark" "$v" "$(cygpath -w "$exe")"
  done
  echo "   * = first on PATH; this is what \`node\` runs"
  echo

  echo "== PATH entries that look node-related, in search order"
  echo "$PATH" | tr ':' '\n' | grep -iE 'node|npm|nvm|fnm|volta|scoop' | nl -w2 -s'  ' || echo "   (none)"
  echo

  echo "== npm"
  echo "   npm.cmd on PATH: $(where.exe npm 2>/dev/null | head -n1 | tr -d '\r' || echo '?')"
  echo "   npm -v:          $(npm -v 2>/dev/null || echo '?')"
  echo "   global prefix:   $(npm prefix -g 2>/dev/null || echo '?')"
  for var in NVM_HOME NVM_SYMLINK FNM_DIR VOLTA_HOME NODE_PATH; do
    [ -n "${!var:-}" ] && echo "   $var=${!var}"
  done
  echo

  echo "== node.exe processes running right now"
  MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq node.exe" 2>/dev/null | grep -i node.exe || echo "   (none)"
}

update() {
  local ver=${1#v}
  [[ $ver =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "give a version like 24.22.1"
  [ -n "$active" ] || die "no node on PATH; nothing to replace"
  local dir; dir=$(dirname "$active")
  case "$(printf %s "$dir" | lc)" in
    */program\ files*) die "active node is under Program Files: update it with the nodejs.org MSI (admin), not this script" ;;
    *nvm*|*fnm*|*volta*|*scoop*) die "active node is managed by a version manager; use it, e.g. nvm install $ver && nvm use $ver" ;;
  esac
  [ -f "$dir/node.exe" ] || die "no node.exe in $dir"

  if MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq node.exe" 2>/dev/null | grep -qi node.exe; then
    die "node.exe is running (Claude Code? a watcher? another terminal?) - close it and retry"
  fi

  local arch; arch=$("$active" -p process.arch 2>/dev/null || echo x64)
  local name="node-v$ver-win-$arch" zip="$name.zip" base="https://nodejs.org/dist/v$ver"
  local tmp; tmp=$(mktemp -d); cd "$tmp"

  echo "downloading $base/$zip"
  curl -fsSLO "$base/$zip" && curl -fsSLO "$base/SHASUMS256.txt" \
    || die "download failed. Behind Zscaler, point CURL_CA_BUNDLE at the corporate CA bundle; never use curl -k"
  grep " $zip\$" SHASUMS256.txt | sha256sum -c - >/dev/null || die "SHA-256 mismatch: do not install this file"
  echo "checksum ok"

  if [ -x /c/Windows/System32/tar.exe ]; then
    /c/Windows/System32/tar.exe -xf "$zip"
  else
    powershell -NoProfile -Command "Expand-Archive -Path '$(cygpath -w "$tmp/$zip")' -DestinationPath '$(cygpath -w "$tmp")'"
  fi
  [ -f "$tmp/$name/node.exe" ] || die "extract failed"

  local old; old=$("$active" --version)
  local bak="$dir.bak-$old"
  [ -e "$bak" ] && die "backup path already exists: $bak"
  echo "replacing $(cygpath -w "$dir")   (backup -> $(cygpath -w "$bak"))"
  mv "$dir" "$bak"
  mv "$tmp/$name" "$dir"

  echo
  echo "node -v: $("$dir/node.exe" --version)   (was $old)"
  echo "npm -v:  $(npm -v 2>/dev/null || echo '?')   (should still be your global npm; if it dropped to the bundled version, PATH order changed)"
  echo "when satisfied, remove the backup:  rm -rf \"$bak\""
}

case "${1:-}" in
  "")       scan 0 ;;
  --deep)   scan 1 ;;
  update)   update "${2:-}" ;;
  *)        echo "usage: $(basename "$0") [--deep] | update <version>" >&2; exit 2 ;;
esac
