#!/usr/bin/env bash
# new-project.sh <python|node-gas|ruby-connector> <work|personal|sandbox> <name>
#   e.g.  new-project.sh python work recipe-linter
# Copies templates/_common + templates/<kind> into $DEV_ROOT/<group>/<name>, git init, make setup.
set -euo pipefail

DEVKIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_ROOT="${DEV_ROOT:-/d/dev}"

kind="${1:-}"; group="${2:-}"; name="${3:-}"
[ -d "$DEVKIT/templates/$kind" ] && [ -n "$group" ] && [ -n "$name" ] || {
  echo "usage: $(basename "$0") <$(ls "$DEVKIT/templates" | grep -v _common | paste -sd'|')> <work|personal|sandbox> <name>" >&2; exit 2; }

dest="$DEV_ROOT/$group/$name"
[ -e "$dest" ] && { echo "exists: $dest" >&2; exit 1; }

mkdir -p "$dest"
cp -r "$DEVKIT/templates/_common/." "$dest/"
cp -r "$DEVKIT/templates/$kind/."   "$dest/"
pkg="${name//-/_}"                                   # python-safe identifier
grep -rl -e PROJECT_NAME -e PROJECT_PKG "$dest" | xargs -r sed -i "s/PROJECT_NAME/$name/g; s/PROJECT_PKG/$pkg/g"
find "$dest" -depth -name 'PROJECT_PKG' -execdir mv {} "$pkg" \;

cd "$dest"
git init -q
make setup
git add -A && git commit -qm "scaffold: $kind project"
echo "ready: $dest  ->  cd $dest && claude"
