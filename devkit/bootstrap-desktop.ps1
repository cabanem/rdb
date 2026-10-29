<#
.SYNOPSIS
  Claude Desktop on 3P (Bedrock) bootstrap for a dev VM where Zscaler blocks downloads.claude.ai.
  Companion to bootstrap.sh. User-scoped, no admin, safe to re-run.

.DESCRIPTION
  The installer can only be fetched from a machine that can reach claude.ai, so this runs twice:

  LAPTOP  (can reach claude.ai)             .\desktop-bootstrap.ps1 -Download
          Downloads the OFFLINE .msix (bundles the VM workspace + Claude CLI, so the VM never
          needs downloads.claude.ai), records version + SHA-256, and tells you what to copy.

  VM      (Git Bash or 64-bit PowerShell)   powershell -NoProfile -ExecutionPolicy Bypass -File desktop-bootstrap.ps1
          1. finds the .msix (D:\dev\tools or the RDP-redirected laptop drive \\tsclient\...)
          2. verifies the hash and installs it per-user with Add-AppxPackage
          3. persists NODE_EXTRA_CA_CERTS / AWS_CA_BUNDLE at USER scope (bashrc exports never reach a
             Start-menu launch)
          4. writes the 3P configuration to HKCU\SOFTWARE\Policies\Claude so the app opens straight
             into Bedrock mode - the registry twin of the in-app "Configure Third-Party Inference" window
          5. prints how to verify

  Options: -Region (default $env:AWS_REGION or us-east-1)  -AwsProfile bedrock
           -Models "us.anthropic....-v1:0","..."  (omitted = discover via the profile, if it may list them)
           -Installer <path>  -DryRun  -NoConfig  -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Download,
  [string]$Installer,
  [string]$Region     = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { 'us-east-1' }),
  [string]$AwsProfile = 'bedrock',
  [string[]]$Models,
  [switch]$DryRun,
  [switch]$NoConfig,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ToolsDir  = 'D:\dev\tools'
$MsixName  = 'Claude-offline-x64.msix'
$RedirUrl  = 'https://claude.ai/api/desktop/win32/x64/offline/latest/redirect'
$PolicyKey = 'HKCU:\SOFTWARE\Policies\Claude'
$CertDir   = Join-Path $env:USERPROFILE '.certs'    # same folder bootstrap.sh writes

function Log([string]$m)  { Write-Host "`n==> $m" -ForegroundColor Blue }
function Note([string]$m) { Write-Host "    $m" }
function Warn([string]$m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Act([string]$what, [scriptblock]$do) {   # every mutation goes through here so -DryRun is honest
  if ($DryRun) { Note "[dry-run] $what" } else { Note $what; & $do }
}

# =============================================================== LAPTOP: -Download
if ($Download) {
  Log "Resolving current offline installer"
  $head = & curl.exe -sI $RedirUrl                    # curl.exe ships with Win10/11; trusts the OS store
  $loc  = ($head | Select-String -Pattern '^location:\s*(\S+)' -CaseSensitive:$false).Matches[0].Groups[1].Value
  if (-not $loc) { throw "No redirect from $RedirUrl (404 = offline build not published yet; retry later)" }
  Note "versioned URL: $loc"

  $dest = Join-Path (Get-Location) $MsixName
  Log "Downloading -> $dest  (several GB; be patient)"
  & curl.exe -fL --progress-bar -o $dest $loc
  if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE)" }

  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash
  @("url=$loc", "sha256=$hash", "downloaded=$(Get-Date -Format s)") | Set-Content "$dest.sha256.txt"
  Note "sha256: $hash"
  Log "Next: copy BOTH files to the VM"
  Note "RDP > Local Resources > More > Drives (tick your drive), reconnect, then on the VM:"
  Note "  cp //tsclient/C/<path-to>/$MsixName* /d/dev/tools/      (Git Bash)"
  Note "then run this script there without -Download."
  return
}

# =============================================================== VM: -Uninstall
if ($Uninstall) {
  Log "Removing Claude Desktop (per-user) and the HKCU 3P configuration"
  Act "Remove-AppxPackage"   { Get-AppxPackage | Where-Object Name -match 'Claude' | Remove-AppxPackage }
  Act "Remove $PolicyKey"    { Remove-Item $PolicyKey -Recurse -ErrorAction SilentlyContinue }
  Note "left alone: %LOCALAPPDATA%\Claude-3p (logs, sessions) - delete by hand if you want a clean slate"
  return
}

# =============================================================== VM: preflight
Log "Preflight"
if ([IntPtr]::Size -ne 8) { throw "32-bit PowerShell: Appx cmdlets need the 64-bit host (C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe)" }
$hklm = Get-Item 'HKLM:\SOFTWARE\Policies\Claude' -ErrorAction SilentlyContinue
if ($hklm -and $hklm.ValueCount -gt 0) { throw "Machine policy exists under HKLM\SOFTWARE\Policies\Claude; the app ignores HKCU while it does. Stop and ask who put it there." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Warn "git not on PATH in this session - the Code tab needs Git for Windows installed (it is, if bootstrap.sh ran)" }
$cred = Join-Path $env:USERPROFILE '.aws\credentials'; $conf = Join-Path $env:USERPROFILE '.aws\config'
$hasProfile = ((Test-Path $cred) -and ((Get-Content $cred) -match "^\[$AwsProfile\]")) -or
              ((Test-Path $conf) -and ((Get-Content $conf) -match "^\[profile $AwsProfile\]"))
if (-not $hasProfile) { throw "AWS profile [$AwsProfile] not found in ~/.aws - run the Idira/Set-AWSCredential step first" }
Note "profile [$AwsProfile] present; region $Region"

# =============================================================== 1. installer
Log "Locating $MsixName"
if (-not $Installer) {
  $candidates = @((Join-Path $ToolsDir $MsixName)) +
                @(Get-ChildItem '\\tsclient\*\Users\*\Downloads', '\\tsclient\*\' -Filter $MsixName -ErrorAction SilentlyContinue | ForEach-Object FullName)
  $Installer = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Installer) {
  throw "not found. Run with -Download on the laptop, copy to $ToolsDir (or leave it on the RDP-redirected drive), re-run."
}
Note "using $Installer"
if (Test-Path "$Installer.sha256.txt") {
  $expected = ((Get-Content "$Installer.sha256.txt") -match '^sha256=') -replace '^sha256=', ''
  $actual   = (Get-FileHash $Installer -Algorithm SHA256).Hash
  if ($expected -ne $actual) { throw "SHA-256 mismatch - the copy over RDP is incomplete or altered. Expected $expected got $actual" }
  Note "sha256 verified"
} else { Warn "no .sha256.txt beside the installer; skipping integrity check" }
if ($Installer -like '\\tsclient\*') {
  $local = Join-Path $ToolsDir $MsixName
  Act "copy to $local (installing straight off the RDP drive is slow and flaky)" {
    New-Item -ItemType Directory -Force $ToolsDir | Out-Null; Copy-Item $Installer $local -Force
    if (Test-Path "$Installer.sha256.txt") { Copy-Item "$Installer.sha256.txt" "$local.sha256.txt" -Force }
  }
  $Installer = $local
}

# =============================================================== 2. install
Log "Install (per-user, no elevation)"
$installed = Get-AppxPackage | Where-Object Name -match 'Claude' | Select-Object -First 1
if ($installed) {
  Note "already installed: $($installed.Name) $($installed.Version) - re-running Add-AppxPackage upgrades in place if the .msix is newer"
}
Act "Add-AppxPackage $Installer" {
  try { Add-AppxPackage -Path $Installer }
  catch {
    if ($_.Exception.Message -match '0x800B0109|0x80073CF9|AllowAllTrustedApps|sideload') {
      Warn "Windows refused the package: $($_.Exception.Message)"
      Warn "Server often needs 'Allow all trusted apps to install' - that's an HKLM/GPO switch, so this one IS an ask for the platform team:"
      Warn "  HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock  AllowAllTrustedApps = 1"
    }
    throw
  }
}

# =============================================================== 3. certs
Log "Persist Zscaler trust for GUI-launched processes (user scope)"
$zs = Join-Path $CertDir 'zscaler.pem'; $bundle = Join-Path $CertDir 'ca-bundle.pem'
if (Test-Path $zs) {
  Act "setx NODE_EXTRA_CA_CERTS $zs  (embedded Node agent)" { [Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $zs, 'User') }
} else { Warn "$zs missing - run bootstrap.sh first, or the embedded agent may fail TLS behind Zscaler" }
if (Test-Path $bundle) {
  Act "setx AWS_CA_BUNDLE $bundle  (the app shells out to aws for profile sign-in)" { [Environment]::SetEnvironmentVariable('AWS_CA_BUNDLE', $bundle, 'User') }
}
Note "these are read at process start: launch Claude from a NEW Start-menu/Explorer session, not a shell opened earlier"

# =============================================================== 4. configuration
if ($NoConfig) { Log "Skipping configuration (-NoConfig): use Developer > Configure Third-Party Inference in the app"; }
else {
  Log "Model list"
  if (-not $Models) {
    if (Get-Command aws -ErrorAction SilentlyContinue) {
      Note "discovering Anthropic inference profiles via [$AwsProfile] in $Region"
      $raw = & aws bedrock list-inference-profiles --profile $AwsProfile --region $Region --output json 2>&1
      if ($LASTEXITCODE -eq 0) {
        $Models = ($raw | ConvertFrom-Json).inferenceProfileSummaries |
                  Where-Object { $_.inferenceProfileId -match 'anthropic\.claude' } |
                  Sort-Object inferenceProfileId -Descending | ForEach-Object inferenceProfileId
      } else { Warn "list-inference-profiles failed (needs bedrock:ListInferenceProfiles): $($raw | Select-Object -First 1)" }
    }
    if (-not $Models -and $env:ANTHROPIC_MODEL) { $Models = @($env:ANTHROPIC_MODEL); Note "falling back to ANTHROPIC_MODEL from the environment" }
  }
  if (-not $Models) { throw "no models. Pass -Models with the inference-profile ID(s) your platform team gave you for Claude Code (e.g. us.anthropic.claude-sonnet-4-6-v1:0)" }
  $Models | ForEach-Object { Note "  $_" }
  $modelsJson = '[' + (($Models | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']'

  Log "Write 3P configuration -> $PolicyKey  (REG_SZ; arrays and booleans as strings, per the docs)"
  $cfg = [ordered]@{
    inferenceProvider          = 'bedrock'
    inferenceBedrockRegion     = $Region
    inferenceBedrockProfile    = $AwsProfile
    inferenceModels            = $modelsJson
    disableAutoUpdates         = 'true'     # update feed is on claude.ai (blocked); you update by re-running with a newer .msix
    modelCatalogEnabled        = 'false'    # otherwise polls downloads.claude.ai every 5-15 min and logs the failure
    disableNonessentialTelemetry = 'true'   # analytics go to claude.ai anyway; essential (crash) telemetry left at default
  }
  Act "New-Item $PolicyKey" { New-Item -Path $PolicyKey -Force | Out-Null }
  foreach ($k in $cfg.Keys) {
    Act ("{0,-28} = {1}" -f $k, $cfg[$k]) { Set-ItemProperty -Path $PolicyKey -Name $k -Value $cfg[$k] -Type String }
  }
  Note "to go back to the in-app window later:  Remove-Item '$PolicyKey' -Recurse"
}

# =============================================================== 5. verify
Log "Done. Verify:"
Note "1. Start > Claude. It should open in third-party mode, not the claude.ai sign-in screen."
Note "   If you see sign-in: fully quit (tray icon too) and relaunch; policy is read at start."
Note "2. Help > Troubleshooting > Generate Diagnostic Report > Export to file. In the zip:"
Note "     deployment-mode.txt  -> third-party"
Note "     provider-status.txt  -> provider settings complete and valid"
Note "     managed-config.txt   -> each key above with its value (misspelled keys are silently ignored)"
Note "3. Log on trouble: %LOCALAPPDATA%\Claude-3p\Logs\main.log"
Note "4. Code tab > open D:\dev\work\<repo>. Cowork only if desktop-readiness.ps1 passed virtualization."
Note "Update later: re-run -Download on the laptop, copy, re-run here (Add-AppxPackage upgrades in place)."
