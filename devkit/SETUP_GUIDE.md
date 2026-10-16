# Claude Code on the Dev VM — Setup Guide (Bedrock + Zscaler)

Oct 15, 2026 · @Emily Cabaniss

## What this guide covers

This gets Claude Code (the CLI) running on your Windows Server 2022 dev VM, authenticated to Amazon Bedrock with the AWS keys Idira hands you, through the Zscaler proxy, with no admin rights and no desktop app. Expect about an hour the first time, most of it waiting on downloads.

When you are done you have:

- A Git Bash shell on the VM where `claude` works from any repo under `D:\dev\`
- The AWS CLI and your per-developer Bedrock profile in `~/.aws/credentials`
- A Zscaler-aware certificate bundle that Node, npm, Python, curl and the AWS CLI all trust
- User-scoped tools (`scoop`, `uv`, `fnm`, `make`, `jq`) that never trigger an elevation prompt

Everything here was learned by actually doing it; the Troubleshooting section at the end lists each error we hit, in the order we hit them. The `devkit` (`bootstrap.sh`, `bashrc`, `new-project.sh`) referenced throughout is the team scaffolding kit; ask Emily for the current zip.

## Ground rules

Four decisions shape everything below. Each one removes a class of problem rather than fixing an instance of it.

**Never elevate.** Every tool here installs into your user profile. A toolchain that never asks for admin is one Idira's privilege controls never block. Scoop's installer actively refuses to run from an elevated PowerShell, so check which kind you have:

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')
```

`False` is what you want. If every shell on the VM says `True` (UAC disabled, common on servers), there is no unelevated shell to open; see Step 2 for the `-RunAsAdmin` escape hatch, and then use that same kind of shell for scoop from then on.

**Config on C, code on D.** Git Bash's home (`~`) is `C:\Users\<account>`, where `.bashrc`, `.gitconfig`, `.aws\` and `.claude\` live. All repos go under `D:\dev\{work,personal,sandbox}`, well away from Automation Anywhere's folders on D. Tools installed on C are reachable from a shell sitting on D because `PATH` is a list of directories, not drives. If a tool "isn't found" from D, the fix is always `PATH`, never moving the tool.

**Git Bash is the shell.** Claude Code, `make`, and the devkit scripts assume it. PowerShell is only for the handful of things that need it (scoop, `Set-AWSCredential`). Git Bash copies the Windows `PATH` when it starts, so after any installer, open a new window before testing.

**Windows-style paths in env vars.** `NODE_EXTRA_CA_CERTS`, `AWS_CA_BUNDLE`, `SSL_CERT_FILE` and npm's `cafile` are read by native Windows programs, which do not understand `/c/Users/...`. Use `C:/Users/...`. In the devkit `bashrc`, `cygpath -m` does this conversion.

## Step 1 — Zscaler certificate bundle

Zscaler sits between the VM and the internet and re-signs every HTTPS connection with its own root certificate. Windows trusts that root (it is in the machine store), so browsers, git (with the `schannel` backend) and PowerShell are fine. Node, npm, Python, curl and the AWS CLI ship their own CA bundles and are not, which is where "unable to get local issuer certificate" comes from.

The fix is done once, by `bootstrap.sh`, and consumed by every tool through env vars in `bashrc`:

1. Export the Zscaler root from the Windows store to `C:\Users\<account>\certs\zscaler.pem`.
2. Concatenate Git's Mozilla bundle with it to make `certs\ca-bundle.pem`.
3. Point each tool at the right file. Two shapes exist, which is why there are two files:

| Tool | Variable or setting | File | Why |
| --- | --- | --- | --- |
| Node / Claude Code | `NODE_EXTRA_CA_CERTS` | `zscaler.pem` | Takes an *extras* file added to its own bundle |
| npm | `npm config set cafile` | `ca-bundle.pem` | npm reads its own config, not Node's env var |
| Python (requests) | `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` | `ca-bundle.pem` | Needs one *complete* bundle |
| AWS CLI | `AWS_CA_BUNDLE` | `ca-bundle.pem` | Needs one *complete* bundle |
| curl | `CURL_CA_BUNDLE` | `ca-bundle.pem` | Needs one *complete* bundle |
| uv | `UV_NATIVE_TLS=1` | (none) | Uses the Windows store directly |
| git | `http.sslBackend schannel` | (none) | Uses the Windows store directly |

If `bootstrap.sh` prints "no Zscaler cert in Root stores," ask IT for the Zscaler root CA, save it as `zscaler.pem` in that folder, and re-run. Verify with `curl -sI https://registry.npmjs.org | head -1` from a new Git Bash: `HTTP/2 200` means the bundle works.

## Step 2 — scoop and the toolchain

Scoop is a user-scoped package manager: it installs into `C:\Users\<account>\scoop\` and puts shims in `scoop\shims\`, which `bashrc` adds to `PATH`. Install it by hand first; the original `bootstrap.sh` skipped this step by mistake (see the fix below).

From a **non-elevated** PowerShell:

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
irm get.scoop.sh | iex
```

If the only shells you can open are elevated, use the explicit override instead of the second line:

```powershell
iex "& {$(irm get.scoop.sh)} -RunAsAdmin"
```

Open a fresh PowerShell and confirm with `scoop --version`. If `irm` itself fails, Zscaler is blocking `get.scoop.sh`; raise it with IT, and install `uv`, `fnm` and Ruby from their own installers in the meantime.

Then run `bash bootstrap.sh` from Git Bash. It is idempotent: re-running after a failure skips what already succeeded. Before running it, make two edits:

1. **Fix the scoop detection.** The script defines a bash helper named `scoop()` near the top, and the install check `if ! have scoop ...` sees that function and concludes scoop is installed. Replace the condition with a file test:

```bash
if [ ! -f "$HOME/scoop/shims/scoop.ps1" ]; then
```

2. **Drop `aws` from the tools line** if you already installed the AWS CLI from the MSI (Step 3). Two `aws.exe` on `PATH` is an ambiguity you do not want.

The tools line becomes `scoop install uv fnm ruby make ripgrep jq`. If it fails, run `scoop install jq` alone in PowerShell: if that works, the failure is one specific package (usually `ruby`, the largest download) and you can install the rest one at a time; if `jq` fails with a download or hash error, Zscaler is blocking GitHub, where scoop fetches most packages, and that goes to IT.

## Step 3 — AWS CLI and Bedrock credentials

Claude Code talks to Bedrock through the AWS SDK's default credential chain. It needs your keys in the shared credentials file; it does not need the AWS CLI at all. The CLI is still worth installing because it is the fastest way to prove the keys and the proxy work before you start `claude`.

**Install the CLI.** The AWS MSI installer puts `aws.exe` in `C:\Program Files\Amazon\AWSCLIV2\`. That path is added to the Windows `PATH`, but only new shells see it. If a fresh Git Bash still says `aws: command not found`, add it yourself in `~/.bashrc`:

```bash
export PATH="/c/Program Files/Amazon/AWSCLIV2:$PATH"
```

`type -a aws` shows every `aws` on `PATH`; you want exactly one.

**Get your keys from Idira.** Idira in our environment is a secrets vault: it hands each developer the access key and secret for their own per-developer service account. These are plain long-lived IAM keys, not short-lived session tokens, so no refresh hooks are needed. Never put them in `.bashrc`, a repo, or a Workato connection.

**Store them where every tool can see them.** `Set-AWSCredential` (from the AWS Tools for PowerShell module, a separate product from the CLI) has two destinations, and the default is the wrong one:

| `-ProfileLocation` | Written to | Readable by |
| --- | --- | --- |
| Omitted (default) | `%LOCALAPPDATA%\AWSToolkit\RegisteredAccounts.json`, encrypted | PowerShell cmdlets only |
| `$env:USERPROFILE\.aws\credentials` | `C:\Users\<account>\.aws\credentials`, plain INI | AWS CLI, Claude Code, every SDK |

So, from PowerShell:

```powershell
Set-AWSCredential -AccessKey <key> -SecretKey <secret> -StoreAs bedrock -ProfileLocation "$env:USERPROFILE\.aws\credentials"
```

(`aws configure --profile bedrock` from Git Bash writes the same file.) Check with `Get-AWSCredential -ListProfileDetail`: the `bedrock` profile's `StoreTypeName` must be `SharedCredentialsFile`.

If the platform team gave you a role to assume (`rol-bedrock-invoke-rsr` or similar) on top of the service-account keys, add it in `~/.aws/config`; the CLI and Claude Code both resolve the chain automatically:

```ini
[profile bedrock-role]
role_arn = arn:aws:iam::<account-id>:role/rol-bedrock-invoke-rsr
source_profile = bedrock
region = us-east-1
```

**Verify** from a new Git Bash:

```bash
aws sts get-caller-identity --profile bedrock
```

An ARN back means keys, proxy and bundle all work. `InvalidClientTokenId` means the keys are wrong or rotated; an SSL error means `AWS_CA_BUNDLE` is unset or pointing at the wrong file.

## Step 4 — Install Claude Code with npm

The native installer (`irm https://claude.ai/install.ps1 | iex`) does not work here: it downloads from `claude.ai`, `downloads.claude.ai` and `storage.googleapis.com`, and Zscaler blocks them. Do not request an exception. Those domains are only needed by the installer and the auto-updater; once Claude Code is running on Bedrock, all model traffic goes to AWS and none of them is used ([Anthropic's network docs](https://code.claude.com/docs/en/network-config)).

Install through npm instead, which pulls from `registry.npmjs.org`. From a new Git Bash, after `bootstrap.sh` has installed Node via `fnm`:

```bash
npm config set cafile "C:/Users/<account>/certs/ca-bundle.pem"
npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
claude --version
```

Two things in that second line catch people:

- **The package name appears twice, on purpose.** `--allow-scripts=<pkg>` names which package may run its install scripts; it is not the thing being installed. Leave off the trailing name and npm tries to install the current directory, failing with "package.json not found."
- **`--allow-scripts` is required since npm 12** (July 2026), which blocks `preinstall`/`postinstall` scripts by default. Claude Code's postinstall is what unpacks the native binary, so without the flag you get a package with no working `claude`. The same flag will be needed for any other global tool with an install script.

Then add to the devkit `bashrc` so Claude Code never tries the blocked domains:

```bash
export DISABLE_AUTOUPDATER=1                       # updater pulls from downloads.claude.ai
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1  # telemetry and version checks
```

Upgrades are manual from now on: `npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest`.

If the install fails on a download *during the postinstall*, read the domain in the error. A block on `registry.npmjs.org` would break far more than Claude Code and is worth an IT ticket; a block on anything else means the postinstall is fetching the binary from a blocked host and the install path needs rethinking. An SSL error means the `cafile` line points at the wrong path.

## Step 5 — Configure Claude Code for Bedrock and verify

Claude Code's Bedrock mode is switched on by environment variables, not by the login wizard. The devkit `bashrc` already exports `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION`; confirm the region matches where our Bedrock models are enabled (ask the platform team). Claude Code does *not* read the region from `~/.aws/config` in Bedrock mode, so the env var is required.

Put the profile and model pins in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "us-east-1",
    "AWS_PROFILE": "bedrock",
    "ANTHROPIC_MODEL": "us.anthropic.claude-sonnet-4-6",
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Use `AWS_PROFILE=bedrock-role` instead if you set up the role-assumption profile in Step 3. The `us.` prefix is the cross-region inference profile; use whatever the platform team enabled. Leave out `awsAuthRefresh` and `awsCredentialExport`: those hooks exist for credentials that expire mid-session, and ours do not.

If Claude Code reports it cannot find Git Bash, add `"CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"` at the top level of the same file.

**Verify**, in order, from a new Git Bash in any repo under `D:\dev\`:

1. `aws sts get-caller-identity --profile bedrock` returns an ARN (Step 3).
2. `claude --version` prints a version.
3. `claude` starts and answers a trivial prompt. The first request is the real test: a `ValidationException` or `AccessDeniedException` here is an IAM policy or model-access problem on the AWS side, not a local one, so send the full error to the platform team.

## Daily workflow

RDP into the VM, open Git Bash, `cd` into a repo, run `claude`. That is the whole loop; nothing needs to be installed on your laptop.

```bash
cd /d/dev/work/<repo>
claude
```

Claude Code reads the repo's `CLAUDE.md` (and the global one at `~/.claude/CLAUDE.md` that `bootstrap.sh` installed) for project conventions, so keep those current. New projects come from `new-project.sh <python|node-gas|ruby-connector> <work|personal|sandbox> <name>`, which scaffolds the repo, runs `make setup`, and makes the first commit.

Keeping the VM the only place `claude` runs is deliberate: your Bedrock keys, the Zscaler bundle and the per-developer service account all live there, and copying keys to another machine is exactly what Idira exists to prevent. If RDP itself is the friction, VS Code Remote-SSH or plain `ssh` into the VM gives a terminal without a full desktop session; that needs OpenSSH Server enabled on the VM, which is an admin request to the platform team.

When Idira rotates your keys, `claude` will start failing with `InvalidClientTokenId`. Pull the new pair from Idira and re-run the `Set-AWSCredential` line from Step 3 into the same profile.

## Troubleshooting

Every row below was hit during the first setup, in roughly this order. Most come down to three causes: a stale `PATH`, a tool trusting the wrong CA bundle, or a domain Zscaler blocks.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `aws: command not found` in Git Bash, but `where.exe aws` finds it in cmd | Git Bash copied `PATH` before the MSI ran, or the MSI only updated the Windows `PATH` | Open a new Git Bash; if still missing, add the `AWSCLIV2` dir to `PATH` in `~/.bashrc` |
| `aws` works but "tool is on C, repo is on D" worry | Not a problem; `PATH` is directory-based | Nothing to do |
| `Get-STSCallerIdentity` works in PowerShell, `aws sts get-caller-identity` says no credentials | `Set-AWSCredential` wrote to the encrypted .NET SDK store | Re-run it with `-ProfileLocation "$env:USERPROFILE\.aws\credentials"` |
| `scoop: The term 'scoop' is not recognized` after `bootstrap.sh` | Script's own `scoop()` bash function fooled the "already installed" check | Install scoop by hand (Step 2), patch the check to a file test |
| Scoop installer refuses: "running as administrator" | Elevated shell | Use a non-elevated PowerShell, or `-RunAsAdmin` if none exists |
| `irm https://claude.ai/install.ps1` blocked | Zscaler blocks `claude.ai`; expected on a Bedrock-routed org | Install via npm (Step 4); do not request an exception |
| npm: package not allowlisted, suggests `--allow-scripts` | npm 12 blocks install scripts by default | Add `--allow-scripts=@anthropic-ai/claude-code` **and** keep the package name at the end |
| ` npm install -g --allow-scripts=...  ` → "package.json not found" | Package name was consumed by the flag; npm installed the cwd | Put `@anthropic-ai/claude-code` after the flag as well |
| `unable to get local issuer certificate` from Python, npm, curl or AWS CLI | Tool uses its own CA bundle, not the Windows store | Point its variable at `ca-bundle.pem` (Step 1 table); npm needs `npm config set cafile` |
| `InvalidClientTokenId` from `aws` or `claude` after it used to work | Idira rotated the keys | Pull new keys, re-run `Set-AWSCredential` into the same profile |
| `claude` loops opening browser tabs | `awsAuthRefresh` set for an SSO flow we do not use | Remove it from `settings.json` |
| `claude` cannot find bash | Git Bash not on its search path | Set `CLAUDE_CODE_GIT_BASH_PATH` in `settings.json` |
| Scoop package download or hash error | Zscaler blocking GitHub release downloads | IT ticket; install that tool from its own installer meanwhile |
| `make: missing separator` | Makefile recipe indented with spaces | Recipes must be tabs |

If you hit something not listed, add a row. The first person to solve it saves the next five.
