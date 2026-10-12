# Global preferences (Emily)

## How I like to work
- Simple, minimal solutions. Ask before adding a dependency, abstraction, or config file.
- When a choice isn't obvious, say why in a sentence. I want to understand the mechanism, not just the fix.
- Push back if I'm overcomplicating something.

## Environment
- Windows Server 2022, Git Bash. Native Windows paths for tools (C:/...), POSIX paths in bash (/c/...).
- Python: `uv` only (`uv run`, `uv add`). Never `pip install` into system Python 3.12.
- Node: `fnm`, version pinned per repo in `.node-version`. GAS projects deploy with `clasp`.
- Ruby: Bundler per repo; Workato connector SDK via `bundle exec workato`.
- Every repo has a Makefile with `setup`, `test`, `lint`. Use those, not ad-hoc commands.
- Shell scripts: bash, LF endings, `set -euo pipefail`.

## Boundaries
- Stay inside the current repo. Don't read or modify siblings under D:/dev.
- Never read `.venv/`, `node_modules/`, or `vendor/`.
- Never write secrets into files; credentials come from env or AWS/GCP tooling.
