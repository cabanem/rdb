#!/usr/bin/env bash
# new-project.sh [--no-setup] <kind> <work|personal|sandbox> <name>
#   e.g.  new-project.sh python work recipe-linter
# Copies templates/_common + templates/<kind> into $DEV_ROOT/<group>/<name>,
# commits the scaffold, then runs preflight/<kind>.sh (if present) and `make setup`.
set -euo pipefail

DEVKIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_ROOT="${DEV_ROOT:-/d/dev}"

die() { echo "error: $*" >&2; exit 1; }
usage() {
  local kinds=() d
  for d in "$DEVKIT"/templates/*/; do d=${d%/}; d=${d##*/}; [ "$d" != _common ] && kinds+=("$d"); done
  echo "usage: $(basename "$0") [--no-setup] <$(IFS='|'; echo "${kinds[*]}")> <work|personal|sandbox> <name>" >&2
  exit 2
}

run_setup=1
[ "${1:-}" = --no-setup ] && { run_setup=0; shift; }
[ $# -eq 3 ] || usage
kind=$1 group=$2 name=$3

# Validation: constrains what reaches the filesystem paths and the sed expressions below.
[[ $kind =~ ^[a-z0-9-]+$ && -d $DEVKIT/templates/$kind ]] || die "unknown kind: $kind"
case $group in work|personal|sandbox) ;; *) die "group must be work|personal|sandbox" ;; esac
[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "name: lowercase letters, digits, hyphens; must start alphanumeric"

dest="$DEV_ROOT/$group/$name"
[ -e "$dest" ] && die "exists: $dest"
pkg=${name//-/_}                                     # python-safe identifier

# Until the scaffold is committed, any failure removes the directory
# so a retry isn't blocked by a half-built "exists:".
trap 'rm -rf "$dest"' ERR
mkdir -p "$dest"
cp -r "$DEVKIT/templates/_common/." "$dest/"
cp -r "$DEVKIT/templates/$kind/."   "$dest/"
# -I skips binaries, -Z/-0 handles any filename, --exclude-dir keeps sed out of git objects.
grep -rlIZ --exclude-dir=.git -e PROJECT_NAME -e PROJECT_PKG "$dest" \
  | xargs -0r sed -i "s/PROJECT_NAME/$name/g; s/PROJECT_PKG/$pkg/g"
find "$dest" -depth -name PROJECT_PKG -execdir mv {} "$pkg" \;

cd "$dest"
git init -q
git add -A && git commit -qm "scaffold: $kind project"
trap - ERR

# Setup runs after the commit: a failed `npm ci` / venv build leaves a clean,
# committed scaffold behind rather than nothing.
if [ "$run_setup" = 1 ]; then
  [ -x "$DEVKIT/preflight/$kind.sh" ] && "$DEVKIT/preflight/$kind.sh"
  make setup
fi
echo "ready: $dest  ->  cd $dest && claude"
