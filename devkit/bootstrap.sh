#!/usr/bin/env bash
# devkit bootstrap — run once from Git Bash on the VM; safe to re-run.
#
#   git clone <your-devkit-repo> ~/devkit && bash ~/devkit/bootstrap.sh
#
# Everything installs user-scoped (no admin, no CyberArk/Idira prompts):
#   scoop  -> package manager in ~/scoop (tools only, never project deps)
#   uv     -> Python versions + per-project .venv
#   fnm    -> Node versions, switches on `cd` via .node-version
#   ruby   -> RubyInstaller build (Bundler per project)
#   make   -> uniform `make setup|test|lint` across every repo
#
# Phases: folders -> certs -> git config -> scoop + tools -> runtimes -> dotfiles
set -euo pipefail

DEVKIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_ROOT="${DEV_ROOT:-/d/dev}"
CERT_DIR="$HOME/.certs"
CERT_DIR_WIN="$(cygpath -m "$CERT_DIR")"   # C:/Users/<you>/.certs — native tools can't read /c/...

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
ps()   { powershell -NoProfile -ExecutionPolicy Bypass -Command "$*"; }
scoop(){ ps "scoop $*"; }   # .cmd shims aren't reliable from bash; go through PowerShell

# ---------------------------------------------------------------- 1. folders
log "Workspace layout under $DEV_ROOT"
mkdir -p "$DEV_ROOT"/{work,personal,sandbox} "$CERT_DIR" "$HOME/.claude"

# ---------------------------------------------------------------- 2. certs
# Zscaler sits between you and the internet with its own root cert. Windows trusts it
# (it's in the machine store); Node, Python, curl and the AWS CLI ship their own CA
# bundles and don't. Export it once as PEM; bashrc points each tool at it.
log "Exporting Zscaler root certificate -> $CERT_DIR_WIN/zscaler.pem"
ps '
  $c = Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
       Where-Object { $_.Subject -match "Zscaler" } | Select-Object -First 1
  if (-not $c) { Write-Host "    no Zscaler cert in Root stores (fine if traffic is not intercepted)"; exit 0 }
  $b64 = [Convert]::ToBase64String($c.RawData, "InsertLineBreaks")
  $pem = "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----`n"
  [IO.File]::WriteAllText("'"$CERT_DIR_WIN"'/zscaler.pem", $pem)
  Write-Host "    exported: $($c.Subject)"
'
if [ -f "$CERT_DIR/zscaler.pem" ]; then
  # Combined bundle = Git's Mozilla bundle + Zscaler, for tools that take ONE file (Python, curl, AWS).
  GIT_BUNDLE="$(git config --system --get http.sslcainfo 2>/dev/null || true)"
  [ -f "${GIT_BUNDLE:-}" ] || GIT_BUNDLE=/mingw64/etc/ssl/certs/ca-bundle.crt
  cat "$GIT_BUNDLE" "$CERT_DIR/zscaler.pem" > "$CERT_DIR/ca-bundle.pem"
  echo "    combined bundle: $CERT_DIR_WIN/ca-bundle.pem"
fi

# ---------------------------------------------------------------- 3. git
log "Git defaults"
git config --global http.sslBackend schannel       # git itself trusts the Windows store -> no cert dance
git config --global core.autocrlf input            # never write CRLF; keeps bash scripts runnable
git config --global init.defaultBranch main
git config --global pull.rebase false
if [ -z "$(git config --global --get user.name || true)" ]; then
  warn "set your identity:  git config --global user.name 'Name'; git config --global user.email you@example.com"
fi

# ---------------------------------------------------------------- 4. scoop + tools
log "scoop (user-scoped package manager)"
if ! have scoop && [ ! -x "$HOME/scoop/shims/scoop.cmd" ]; then
  ps 'Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; irm get.scoop.sh | iex'
fi
export PATH="$HOME/scoop/shims:$PATH"
scoop bucket add extras >/dev/null 2>&1 || true

log "Tools: uv fnm ruby make ripgrep jq aws"
scoop install uv fnm ruby make ripgrep jq aws
[ "${WITH_GCLOUD:-0}" = "1" ] && scoop install gcloud   # optional: WITH_GCLOUD=1 bash bootstrap.sh

# ---------------------------------------------------------------- 5. runtimes
log "Runtimes"
export UV_NATIVE_TLS=1                   # uv uses the Windows cert store -> Zscaler already trusted
uv python install 3.12
ps 'fnm install 24; fnm default 24'      # Node LTS; projects pin their own via .node-version

# ---------------------------------------------------------------- 6. Claude Code
log "Claude Code"
if have claude; then
  echo "    already installed: $(claude --version 2>/dev/null || echo '?')"
else
  ps 'irm https://claude.ai/install.ps1 | iex'
fi

# ---------------------------------------------------------------- 7. dotfiles
log "Dotfiles"
LINE="source \"$(cygpath -m "$DEVKIT")/bashrc\""
grep -qF "$LINE" "$HOME/.bashrc" 2>/dev/null || { printf '\n# devkit\n%s\n' "$LINE" >> "$HOME/.bashrc"; echo "    linked bashrc"; }
if [ ! -f "$HOME/.claude/CLAUDE.md" ]; then
  cp "$DEVKIT/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"; echo "    installed global CLAUDE.md"
else
  echo "    ~/.claude/CLAUDE.md exists; left alone (diff against $DEVKIT/claude/CLAUDE.md)"
fi

log "Done. Open a new Git Bash, then:  claude   (login wizard -> 3rd-party platform -> Amazon Bedrock)"
warn "bashrc sets CLAUDE_CODE_USE_BEDROCK=1 and AWS_REGION; confirm the region and inference profile with your platform team."
