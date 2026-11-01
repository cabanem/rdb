# node-vuln-sweep

A Git Bash script for Windows that inventories every Node.js installation and `node_modules` tree on a machine, classifies each by who owns it, audits the ones you own for known vulnerabilities, and optionally applies conservative fixes.

## Overview

Vulnerability scanners (Zscaler and similar) flag a package by *file path*, not by what `npm ls` reports in your current project. A machine accumulates copies of the same library in places you don't normally look: nested dependencies, global installs, Node's own bundled `npm`, version-manager installs, applications that embed Node, old project folders, and the Recycle Bin. When support says "the library looks up to date" and the scanner still complains, the scanner is looking at one of those other copies.

`node-vuln-sweep.sh` answers three questions in one pass:

1. **What's here?** Every `node.exe` and every top-level `node_modules` directory on every mounted drive.
2. **Whose is it?** Each tree is tagged `project`, `global`, `bundled-npm`, `version-manager`, `vendor-app`, or `app-bundled`.
3. **Is it vulnerable, and can I fix it?** `npm audit` runs against trees you own. With `--fix`, safe remediation runs against those same trees. Trees owned by installed applications are reported and never modified.

The script is read-only unless you pass `--fix`.

## Getting started

```bash
# 1. Save the script somewhere on PATH or in your scripts folder, then
chmod +x node-vuln-sweep.sh

# 2. Look before you touch — a read-only pass over your own profile
./node-vuln-sweep.sh --roots "/d/Users/$USERNAME /c/Users/$USERNAME"

# 3. Hunt for the specific package in the scanner finding
./node-vuln-sweep.sh --pkg <package-name>

# 4. Full read-only sweep of all drives (slower; several minutes)
./node-vuln-sweep.sh

# 5. Review the report, then fix what you own
./node-vuln-sweep.sh --fix
```

Each run writes `node-vuln-sweep_<timestamp>.txt` to the current directory. Send that file to support when you ask for a rescan.

### Flags

| Flag | Effect |
|---|---|
| *(none)* | Report only. All mounted drives. |
| `--fix` | Also apply safe fixes to `project`, `global`, and `bundled-npm` trees. |
| `--pkg <name>` | Additionally list every copy of one package with its version. Scoped packages: `--pkg @scope/name`. |
| `--roots "<dir> <dir>"` | Search only these directories (space-separated, Git Bash paths like `/d/Users/me`). |
| `-h`, `--help` | Print usage. |

## Authentication and connection

The script itself needs no credentials and stores none.

**Network.** `npm audit`, `npm outdated -g`, and all `--fix` steps contact the npm registry (`registry.npmjs.org`) over HTTPS. The discovery and classification sections (1, 2, 5) are fully offline.

**TLS inspection (Zscaler).** If your network re-signs HTTPS traffic, Node will reject the registry's certificate unless it trusts the corporate CA. Symptom: audit sections print `audit failed (network?)`, or `npm` logs `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `SELF_SIGNED_CERT_IN_CHAIN`. Fix by pointing Node at the corporate root bundle:

```bash
export NODE_EXTRA_CA_CERTS=/c/path/to/corporate-ca-bundle.pem
```

Put that line in `~/.bashrc` so it persists. Do **not** use `npm config set strict-ssl false`; it disables certificate checking entirely.

**Proxy.** If outbound traffic requires an explicit proxy, npm honours `HTTPS_PROXY` / `HTTP_PROXY` environment variables or `npm config set proxy` / `https-proxy`.

**Privileges.** Run from an elevated Git Bash (Run as administrator) to read `Program Files`, `ProgramData`, and other users' profile directories. Without elevation those directories are silently skipped (their permission errors are discarded), so the inventory will be incomplete. Elevation is also required for any `--fix` action against `bundled-npm` under `Program Files`.

## Prerequisites

| Requirement | Why |
|---|---|
| Windows 10/11 or Windows Server 2019+ | Path layout assumptions (`/c`, `AppData`, `Program Files`). |
| Git for Windows (Git Bash) or MSYS2 | Provides `bash` ≥ 4, GNU `find`, `grep`, `sed`, `tee`, `mapfile`. Will not run in PowerShell or cmd. |
| `node` and `npm` on PATH inside Git Bash | `node` parses audit JSON; `npm` runs the audit and fixes. Check with `command -v node npm`. |
| Local administrator (recommended) | See *Privileges* above. |
| Network access to the npm registry | For sections 3 and 4 and for `--fix`. |

If `node` is missing from PATH, sections 1, 2, and 5 still work; the audit sections degrade gracefully.

## Key actions

The script runs five sections in order, labelled in the output.

**1. Node runtimes.** Finds every `node.exe` and prints its version. Catches "the Node runtime itself is end-of-life," which packaging tools won't fix.

**2. Tree inventory.** Finds every `node_modules` directory, listing each top-level tree once (`find -prune` stops the walk at the first `node_modules`, so nested ones are implied by their parent). Each tree is classified:

| Class | Matched by | Fixed by `--fix`? |
|---|---|---|
| `project` | Anything not matching the rules below | Yes — `npm audit fix` |
| `global` | `…/AppData/Roaming/npm/node_modules` | Yes — `npm update -g` |
| `bundled-npm` | `…/nodejs/node_modules` (npm shipped with Node) | Yes — `npm install -g npm@latest` |
| `version-manager` | path contains `nvm`, `fnm`, or `volta` | No — reported |
| `vendor-app` | under `Program Files`, `Program Files (x86)`, or `ProgramData` | No — reported |
| `app-bundled` | under `AppData/Local`, `.vscode`, `.cursor` | No — reported |

**3. Audit owned projects.** For each `project` tree: skip if no `package.json` (orphan; safe to delete by hand), skip if no `package-lock.json` (audit requires one; `npm i --package-lock-only` generates it without installing anything), otherwise run `npm audit --json` and print counts plus every critical/high finding by name, version range, and whether a fix is available. With `--fix`, run `npm audit fix` (never `--force`).

**4. Global and bundled npm.** Print current `node`/`npm` versions and `npm outdated -g`. With `--fix`: `npm update -g`, `npm install -g npm@latest`, `npm cache clean --force`.

**5. Targeted search (`--pkg`).** Every `node_modules/<pkg>/package.json` on the searched roots, with the version read directly from the file. Use this to locate exactly what a scanner finding names.

Excluded from every walk: `C:\Windows`, `$Recycle.Bin`, `System Volume Information`. See *Acknowledged risks* for the Recycle Bin implication.

## Error handling and telemetry

**Failure isolation.** The script uses `set -uo pipefail` but deliberately not `set -e`: one project whose audit fails (bad lockfile, no network, corrupt tree) prints a line and the sweep continues. Each project is audited in a subshell so a `cd` or crash cannot affect the next one.

**Suppressed noise.** `find` errors are discarded (`2>/dev/null`) because even an administrator cannot read some system directories and each produces a `Permission denied` line. The trade-off: a directory you *expected* to be searched but couldn't be is not reported. If a tree you know exists doesn't appear, re-run elevated or pass it explicitly via `--roots`.

**Audit failures.** If `npm audit` returns anything other than parseable JSON, the project prints `audit failed (network?)`. Almost always this is TLS inspection or no registry access; see *Authentication and connection*.

**Report file.** All console output is duplicated to `node-vuln-sweep_<YYYYMMDD-HHMMSS>.txt` via `tee`. The report is plain text and contains only paths, versions, and advisory names — no credentials, tokens, or file contents.

**Exit codes.** `0` on completion, `2` on an unrecognised flag. Individual audit or fix failures do not change the exit code; read the report.

**No telemetry.** The script sends nothing anywhere except npm's own registry calls, which are the same ones `npm audit` makes when you run it by hand.

## Best practices

- **Read before you fix.** Always run without `--fix` first and check that the classification matches reality on that machine. Anything unrecognised lands in `project`, which `--fix` will touch.
- **Narrow first, widen second.** A pass over your own profile finishes in seconds; a two-drive crawl takes minutes and churns disk. Start narrow.
- **Chase the finding, not the whole machine.** If the scanner named a package, run `--pkg` first. The answer is usually one path.
- **Commit lockfiles.** `npm audit` and `npm ci` both depend on `package-lock.json`. A project without one cannot be audited reproducibly or rebuilt reproducibly.
- **Delete `node_modules` in dormant projects.** `npm ci` rebuilds it from the lockfile in seconds; a folder that doesn't exist can't be flagged.
- **Empty the Recycle Bin after cleanup**, on every drive. Deleting a folder in Explorer only moves it to `$Recycle.Bin`; every file inside is still intact and scannable. Elevated PowerShell: `Clear-RecycleBin -Force` (your account) or `Remove-Item -Recurse -Force 'C:\$Recycle.Bin\*','D:\$Recycle.Bin\*'` (all accounts).
- **Keep tooling out of the system Node.** Use a version manager (`fnm` or `Volta`) for Node itself, `npx` for one-off CLIs, and avoid `npm install -g` for anything but npm and the version manager. This is what prevents the sprawl the script exists to find.
- **Request a rescan.** Most scanners evaluate on a schedule. After fixing, ask for an on-demand scan and attach the report; otherwise "fixed" and "still flagged" will coexist until the next sweep.
- **Hand off what isn't yours.** For `vendor-app`, `app-bundled`, and `version-manager` findings, report the path and the owning product. Patching inside another application's tree is undone on its next update and may break the application.

## Acknowledged risks and issues

- **Classification is heuristic.** It matches well-known Windows paths. A project stored under `Program Files` is misclassified as `vendor-app` (and skipped); an application that installs to an unusual path is misclassified as `project` (and audited, and fixed under `--fix`). Review the inventory before using `--fix` on an unfamiliar machine.
- **`npm audit fix` changes lockfiles.** It bumps versions within existing semver ranges. That is normally safe, but it is a code change: review and commit the resulting `package-lock.json` diff like any other.
- **Transitive pins are not fixed.** When a parent package requires a vulnerable version, audit reports `(no fix available)`. Resolving this needs an `"overrides"` block in `package.json`, which is a per-project judgement the script does not make.
- **Recycle Bins are skipped by default.** The walk prunes `$Recycle.Bin` to avoid crawling scrambled `$R…` names. Deleted projects there are still visible to scanners. To inspect them: `--roots '/c/$Recycle.Bin /d/$Recycle.Bin'` (single quotes so Bash doesn't expand `$Recycle`). To clear them, see *Best practices*.
- **Node runtimes are not updated.** Section 1 reports versions only. Upgrading Node is a deliberate decision (major versions can break projects) and is left to you or your version manager.
- **Orphaned trees are not deleted.** A `node_modules` with no `package.json` beside it is reported as safe to delete, not removed. Look at the path first.
- **Packages outside `node_modules` are invisible.** Electron applications often pack dependencies into `.asar` archives; some installers copy a single JavaScript file rather than a package directory. Scanners that unpack archives will see these; this script will not.
- **The npm cache is opaque.** It is content-addressed, so a specific package cannot be located in it by name. `--fix` clears it wholesale; the next install repopulates it.
- **Multi-user machines.** Each Windows account that has logged in has its own profile and its own Recycle Bin folder (`$Recycle.Bin\<SID>`). An elevated run inventories all of them; the all-accounts bin-clearing command destroys other users' deleted files. On a shared or jump host, prefer `Clear-RecycleBin` for your own account only. To see who has used a machine: `Get-CimInstance Win32_UserProfile | Select-Object LocalPath, LastUseTime`.
- **Long runtimes on large drives.** A full crawl of two drives with many files can take several minutes and generate noticeable disk I/O. Use `--roots` when you can.
- **No Linux/macOS support.** Path assumptions are Windows-specific. The approach (find `node_modules`, classify, audit) ports easily; the classifier does not.
