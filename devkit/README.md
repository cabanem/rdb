# devkit

A VM-in-a-repo: one script to set up the machine, one script to start a project, and a
shell config that makes Zscaler, Bedrock, and the three toolchains behave.

    ~/devkit/                 this repo (clone it to C:\Users\<you>\devkit)
      bootstrap.sh            run once per VM; idempotent
      bashrc                  sourced from ~/.bashrc
      new-project.sh          scaffold a repo under D:\dev
      claude/CLAUDE.md        global Claude Code preferences -> ~/.claude/CLAUDE.md
      templates/              _common + python | node-gas | ruby-connector

## First run (Git Bash)

    git clone <this repo> ~/devkit
    bash ~/devkit/bootstrap.sh          # add WITH_GCLOUD=1 to also install the gcloud CLI
    # open a new Git Bash
    claude                              # login wizard -> 3rd-party platform -> Amazon Bedrock

## New project

    new-project.sh python         work      recipe-linter
    new-project.sh node-gas       work      lib-sdc-foo
    new-project.sh ruby-connector work      connector-bar
    new-project.sh python         sandbox   try-something     # disposable

Every repo gets the same interface: `make setup`, `make test`, `make lint`. Python repos
also have `make fmt` and `make run`; GAS repos `make push/pull/open`; connectors `make exec`.

## Where things live

| What                  | Where                         | Why                                   |
|-----------------------|-------------------------------|---------------------------------------|
| Tools (uv, fnm, ruby) | `~/scoop`                     | user-scoped, no admin, no CyberArk    |
| Python interpreters   | managed by uv                 | `uv python install 3.12`              |
| Node versions         | managed by fnm                | `.node-version` per repo switches it  |
| Project dependencies  | `.venv/`, `node_modules/`, `vendor/` inside each repo | gitignored    |
| Certs                 | `~/.certs`                    | exported once, env vars point at them |
| Code                  | `D:\dev\{work,personal,sandbox}\<repo>` | one repo = one folder       |
| Config                | `C:\Users\<you>` (`~`)        | drive split: config on C, code on D   |

## Troubleshooting

- **SSL "unable to get local issuer"** from Python/Node/aws: `ls ~/.certs` should show
  `zscaler.pem` and `ca-bundle.pem`. If empty, the cert wasn't in the Root store; ask IT for
  the Zscaler root CA and drop it in as `zscaler.pem`, then re-run bootstrap.
- **A Ruby gem fails to compile**: run `ridk install` once (installs the MSYS2 devkit RubyInstaller
  uses for native extensions), then `make setup` again.
- **`make` says "missing separator"**: a Makefile line is indented with spaces. Recipes must be tabs
  (the `.editorconfig` tells editors this).
- **Claude Code can't find Git Bash**: add `"CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"`
  to `~/.claude/settings.json`.
