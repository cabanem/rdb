<#
.SYNOPSIS
  Readiness + diagnostics for Claude Desktop on 3P (Bedrock) on a Windows dev VM behind Zscaler.

.DESCRIPTION
  Read-only. Changes nothing. Works on Windows PowerShell 5.1 (Server 2022 default).
  Checks: OS/hardware, virtualization (Cowork), Virtual Machine Platform, MSIX support,
  existing Claude installs/policies, Git, Zscaler trust + NODE_EXTRA_CA_CERTS, AWS profile,
  OS proxy, and reachability of every host Claude Desktop on 3P needs.

  From Git Bash:
    powershell -NoProfile -ExecutionPolicy Bypass -File desktop-readiness.ps1
  From an elevated PowerShell (adds the "Log on as a service" check):
    .\desktop-readiness.ps1
  Options:
    -Region us-east-1   -AwsProfile bedrock   -SkipNetwork   -OutFile readiness.txt
#>
[CmdletBinding()]
param(
  [string]$Region     = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { 'us-east-1' }),
  [string]$AwsProfile = 'bedrock',
  [switch]$SkipNetwork,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$script:Results = New-Object System.Collections.Generic.List[object]
$script:IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
                  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ---------- reporting ----------------------------------------------------------
function R([string]$Status, [string]$Detail) { [pscustomobject]@{ Status = $Status; Detail = $Detail } }

function Write-Section([string]$Title) {
  Write-Host ""; Write-Host ("== {0} " -f $Title).PadRight(72, '=') -ForegroundColor Cyan
  $script:Results.Add([pscustomobject]@{ Status = ''; Name = "== $Title"; Detail = '' })
}

function Invoke-Check([string]$Name, [scriptblock]$Body) {
  try   { $r = & $Body }
  catch { $r = R 'FAIL' ("error: " + $_.Exception.Message) }
  $color = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; SKIP = 'DarkGray'; INFO = 'Gray' }[$r.Status]
  Write-Host ("[{0}] " -f $r.Status) -ForegroundColor $color -NoNewline
  Write-Host ("{0,-34} {1}" -f $Name, $r.Detail)
  $script:Results.Add([pscustomobject]@{ Status = $r.Status; Name = $Name; Detail = $r.Detail })
}

function Probe([string]$Url, [int]$MaxRedirect = 5) {
  # Returns @{Code; Location; Blocked; Err}. Uses the OS proxy; trusts the Windows cert store.
  try {
    $resp = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 20 -MaximumRedirection $MaxRedirect
    $code = [int]$resp.StatusCode; $hdr = $resp.Headers
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { return @{ Code = 0; Err = $_.Exception.Message } }
    $code = [int]$resp.StatusCode; $hdr = $resp.Headers
  }
  $blocked = ($code -eq 403) -and (($hdr.Keys | ForEach-Object { "$_=$($hdr[$_])" }) -join ' ' -match 'zscaler')
  @{ Code = $code; Location = $hdr['Location']; Blocked = $blocked }
}

# ---------- 1. system ----------------------------------------------------------
Write-Section "System"
$os  = Get-CimInstance Win32_OperatingSystem
$cs  = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1

Invoke-Check "Operating system" {
  $build = [int]$os.BuildNumber; $server = ($os.ProductType -ne 1)
  $d = "$($os.Caption) build $build, $env:PROCESSOR_ARCHITECTURE"
  if ($build -lt 19041)   { return R 'FAIL' "$d - below Windows 10 2004 (19041) minimum" }
  if ($server)            { return R 'WARN' "$d - Server SKU; documented support is Win10 19041+/Win11. Code likely fine, Cowork unverified" }
  R 'PASS' $d
}
Invoke-Check "Running as administrator" {
  if ($script:IsAdmin) { R 'INFO' "yes (MSIX install needs this; service-logon check enabled)" }
  else                 { R 'INFO' "no - re-run elevated for the service-logon check and to install the .msix" }
}
Invoke-Check "Machine type" {
  R 'INFO' "$($cs.Manufacturer) $($cs.Model) - HypervisorPresent=$($cs.HypervisorPresent) (True inside any VM; says nothing about nesting)"
}
Invoke-Check "Memory" {
  $gb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  if ($gb -lt 16) { R 'WARN' "$gb GB - Cowork runs a VM alongside Automation Anywhere; expect pressure" } else { R 'PASS' "$gb GB" }
}
Invoke-Check "Free disk (C:)" {
  $free = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
  if ($free -lt 15) { R 'WARN' "$free GB - offline installer is several GB and unpacks under %LOCALAPPDATA%" } else { R 'PASS' "$free GB" }
}

# ---------- 2. virtualization (Cowork) ------------------------------------------
Write-Section "Virtualization (needed for Cowork only)"
$vmp = Get-CimInstance Win32_OptionalFeature -Filter "Name='VirtualMachinePlatform'"
$vmpOn = ($vmp -and $vmp.InstallState -eq 1)

Invoke-Check "CPU virtualization extensions" {
  $vmx = [bool]$cpu.VMMonitorModeExtensions; $slat = [bool]$cpu.SecondLevelAddressTranslationExtensions
  $fw  = [bool]$cpu.VirtualizationFirmwareEnabled
  $d = "VMX/SVM=$vmx SLAT=$slat FirmwareEnabled=$fw"
  if ($vmx -and $slat) { return R 'PASS' $d }
  if ($vmpOn -and $cs.HypervisorPresent) { return R 'PASS' "$d - flags hidden because a local hypervisor (VMP) is already running" }
  R 'FAIL' "$d - not exposed to this OS. On a VM this means nested virtualization is off on the host; only the platform team can change that. Cowork will not run; Code still will"
}
Invoke-Check "Virtual Machine Platform feature" {
  if (-not $vmp) { return R 'FAIL' "feature not present on this SKU" }
  switch ($vmp.InstallState) {
    1 { R 'PASS' "enabled" }
    2 { R 'FAIL' "disabled - enable (elevated): Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform" }
    default { R 'FAIL' "state $($vmp.InstallState) (absent/unknown)" }
  }
}
Invoke-Check "Related features (info)" {
  $names = 'Microsoft-Hyper-V-All', 'HypervisorPlatform', 'Microsoft-Windows-Subsystem-Linux'
  $f = Get-CimInstance Win32_OptionalFeature | Where-Object { $names -contains $_.Name } |
       ForEach-Object { "{0}={1}" -f $_.Name, @{1='on';2='off'}[[int]$_.InstallState] }
  R 'INFO' (($f -join ', ') + " (none required)")
}
Invoke-Check "'Log on as a service' for VM group" {
  # Cowork's VM runs under NT VIRTUAL MACHINE\Virtual Machines (S-1-5-83-0); error 0x80070569 if denied.
  if (-not $script:IsAdmin) { return R 'SKIP' "needs elevation (secedit). Re-run from an admin PowerShell" }
  $inf = Join-Path $env:TEMP 'claude-user-rights.inf'
  $null = & secedit /export /cfg $inf /areas USER_RIGHTS 2>&1
  $lines = Get-Content $inf; Remove-Item $inf -ErrorAction SilentlyContinue
  $grant = $lines | Where-Object { $_ -match '^SeServiceLogonRight' }
  $deny  = $lines | Where-Object { $_ -match '^SeDenyServiceLogonRight' }
  if ($deny -and $deny -match 'S-1-5-83-0')  { return R 'FAIL' "group is DENIED the right by policy" }
  if (-not $grant)                            { return R 'PASS' "not defined by policy; local default (includes the group) applies" }
  if ($grant -match 'S-1-5-83-0')             { return R 'PASS' "granted: $grant" }
  R 'FAIL' "policy defines the right without the group: $grant"
}

# ---------- 3. install prerequisites --------------------------------------------
Write-Section "Install prerequisites"
Invoke-Check "MSIX tooling" {
  $cmd = Get-Command Add-AppxPackage -ErrorAction SilentlyContinue
  $ai  = Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue
  if (-not $cmd) { return R 'FAIL' "Add-AppxPackage not available" }
  if ($ai) { R 'PASS' "App Installer $($ai.Version) present; Add-AppxPackage available" }
  else     { R 'WARN' "App Installer absent (common on Server) - install with: Add-AppxPackage .\Claude.msix (elevated)" }
}
Invoke-Check "Git for Windows (Code needs it)" {
  $g = Get-Command git -ErrorAction SilentlyContinue
  if ($g) { R 'PASS' ((& git --version) + " at $($g.Source)") } else { R 'FAIL' "git not on PATH for this session" }
}
Invoke-Check "Existing Claude Desktop" {
  $pk = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Claude' })
  $dirs = @("$env:LOCALAPPDATA\Claude-3p", "$env:APPDATA\Claude") | Where-Object { Test-Path $_ }
  $d = @(); if ($pk) { $d += ($pk | ForEach-Object { "$($_.Name) $($_.Version)" }) }; if ($dirs) { $d += "data: $($dirs -join ', ')" }
  if ($d) { R 'INFO' ($d -join '; ') } else { R 'INFO' "none installed (clean slate)" }
}
Invoke-Check "Claude Desktop policy keys" {
  $hklm = Get-Item 'HKLM:\SOFTWARE\Policies\Claude' -ErrorAction SilentlyContinue
  $hkcu = Get-Item 'HKCU:\SOFTWARE\Policies\Claude' -ErrorAction SilentlyContinue
  if ($hklm -and $hklm.ValueCount -gt 0) { return R 'WARN' "HKLM has $($hklm.ValueCount) value(s): $($hklm.GetValueNames() -join ', ') - machine policy locks the in-app window and overrides HKCU" }
  if ($hkcu -and $hkcu.ValueCount -gt 0) { return R 'INFO' "HKCU: $($hkcu.GetValueNames() -join ', ')" }
  R 'PASS' "none - in-app single-machine configuration will be editable"
}
Invoke-Check "Claude Code CLI (info)" {
  $c = Get-Command claude -ErrorAction SilentlyContinue
  $s = Test-Path "$env:USERPROFILE\.claude\settings.json"
  R 'INFO' ("cli=" + $(if ($c) { 'found' } else { 'not on PATH' }) + ", ~/.claude/settings.json=" + $s + " (Desktop ignores it; configure Bedrock in-app)")
}

# ---------- 4. TLS trust (Zscaler) ------------------------------------------------
Write-Section "TLS trust (Zscaler)"
Invoke-Check "Zscaler root in Windows store" {
  $zs = @(Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root | Where-Object { $_.Subject -match 'Zscaler' })
  if ($zs) { R 'PASS' "$($zs.Count) found, e.g. $($zs[0].Subject) [$($zs[0].Thumbprint.Substring(0,8))...] - the app itself trusts the OS store" }
  else     { R 'WARN' "none found under that name - app TLS to Bedrock may fail if Zscaler intercepts" }
}
Invoke-Check "NODE_EXTRA_CA_CERTS (agent)" {
  $u = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'User')
  $m = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Machine')
  $p = $env:NODE_EXTRA_CA_CERTS
  $persisted = $(if ($u) { $u } else { $m })
  if ($persisted) {
    if (Test-Path $persisted) { return R 'PASS' "persisted ($persisted) - visible to GUI-launched apps" }
    return R 'FAIL' "persisted but file missing: $persisted"
  }
  if ($p) { return R 'WARN' "set only for this shell ($p). A Start-menu launch won't see it. Persist: setx NODE_EXTRA_CA_CERTS `"$p`"" }
  R 'WARN' "not set anywhere - needed if the embedded agent fails TLS behind Zscaler"
}

# ---------- 5. AWS ---------------------------------------------------------------
Write-Section "AWS / Bedrock credentials"
Invoke-Check "AWS CLI" {
  $a = Get-Command aws -ErrorAction SilentlyContinue
  if ($a) { R 'PASS' ((& aws --version 2>&1 | Select-Object -First 1)) } else { R 'WARN' "aws not on PATH for this session (in-app sign-in and sts checks use it)" }
}
Invoke-Check "Profile [$AwsProfile] in ~/.aws" {
  $cred = "$env:USERPROFILE\.aws\credentials"; $conf = "$env:USERPROFILE\.aws\config"
  $inCred = (Test-Path $cred) -and ((Get-Content $cred) -match "^\[$AwsProfile\]")
  $inConf = (Test-Path $conf) -and ((Get-Content $conf) -match "^\[profile $AwsProfile\]")
  if ($inCred -or $inConf) { R 'PASS' "found (enter '$AwsProfile' as the AWS profile name in-app)" } else { R 'FAIL' "not found in $cred or $conf" }
}

# ---------- 6. network -----------------------------------------------------------
Write-Section "Network"
Invoke-Check "OS proxy settings" {
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  $target = [uri]"https://bedrock-runtime.$Region.amazonaws.com/"
  $via = [Net.WebRequest]::GetSystemWebProxy().GetProxy($target)
  $route = $(if ($via.AbsoluteUri -eq $target.AbsoluteUri) { 'DIRECT' } else { $via.AbsoluteUri })
  R 'INFO' "ProxyEnable=$($ie.ProxyEnable) ProxyServer='$($ie.ProxyServer)' PAC='$($ie.AutoConfigURL)'; Bedrock resolves to $route (the agent is handed exactly this)"
}

if ($SkipNetwork) {
  Invoke-Check "Reachability" { R 'SKIP' "-SkipNetwork" }
} else {
  Invoke-Check "downloads.claude.ai (offline .msix)" {
    $p = Probe "https://claude.ai/api/desktop/win32/x64/offline/latest/redirect" 0
    if ($p.Code -in 301, 302, 307, 308) { return R 'PASS' "redirects to $($p.Location)" }
    if ($p.Code -eq 404) { return R 'WARN' "reachable, but no offline build published right now - retry later" }
    if ($p.Blocked)      { return R 'FAIL' "blocked by Zscaler (403). Download on the laptop, copy over RDP; set disableAutoUpdates + modelCatalogEnabled=false" }
    R 'FAIL' "unreachable (HTTP $($p.Code)) $($p.Err) - same workaround: offline installer via laptop + RDP"
  }
  Invoke-Check "claude.ai" {
    $p = Probe "https://claude.ai/"
    if ($p.Code -ge 200 -and $p.Code -lt 400) { R 'PASS' "HTTP $($p.Code)" }
    else { R 'WARN' "HTTP $($p.Code) $($p.Err) - needed only for updates/telemetry; set disableAutoUpdates, disableEssential/NonessentialTelemetry" }
  }
  Invoke-Check "api.anthropic.com" {
    $p = Probe "https://api.anthropic.com/"
    if ($p.Code -gt 0 -and -not $p.Blocked) { R 'PASS' "HTTP $($p.Code)" }
    else { R 'WARN' "HTTP $($p.Code) $($p.Err) - needed only for WebFetch preflight/telemetry; set skipWebFetchPreflight=true" }
  }
  foreach ($h in @("bedrock-runtime.$Region.amazonaws.com", "bedrock.$Region.amazonaws.com", "sts.amazonaws.com")) {
    Invoke-Check $h {
      $p = Probe "https://$h/"
      if ($p.Code -gt 0 -and -not $p.Blocked) { R 'PASS' "TLS ok, HTTP $($p.Code) (4xx is expected without a signed request)" }
      elseif ($p.Blocked) { R 'FAIL' "blocked by Zscaler (403)" }
      else { R 'FAIL' "unreachable: $($p.Err)" }
    }.GetNewClosure()
  }
  Invoke-Check "aws sts get-caller-identity" {
    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { return R 'SKIP' "aws not on PATH" }
    $out = & aws sts get-caller-identity --profile $AwsProfile --output text 2>&1
    if ($LASTEXITCODE -eq 0) { R 'PASS' ("ARN " + (($out -split "\s+")[1])) }
    else { R 'FAIL' (($out | Select-Object -First 1) + " (AWS_CA_BUNDLE set? " + [bool]$env:AWS_CA_BUNDLE + ")") }
  }
}

# ---------- summary ----------------------------------------------------------------
Write-Section "Summary"
$counts = $script:Results | Where-Object Status | Group-Object Status -AsHashTable -AsString
$line = ('PASS','WARN','FAIL','SKIP' | ForEach-Object { "{0}={1}" -f $_, @($counts[$_]).Count }) -join '  '
Write-Host $line
$fails = @($script:Results | Where-Object Status -eq 'FAIL')
if ($fails) { Write-Host "`nFAILs:" -ForegroundColor Red; $fails | ForEach-Object { Write-Host "  - $($_.Name): $($_.Detail)" } }
Write-Host "`nVerdict:" -ForegroundColor Cyan
$virtFail = $fails | Where-Object { $_.Name -match 'virtualization|Virtual Machine Platform|Log on' }
if ($virtFail) { Write-Host "  Cowork: NO (virtualization). Code tab: still viable via 3P mode." }
else           { Write-Host "  Cowork: prerequisites look satisfied here; the official readiness check is the final word." }
if ($fails | Where-Object Name -match 'downloads.claude.ai') { Write-Host "  Install path: OFFLINE installer (sneakernet via laptop + RDP)." }
else { Write-Host "  Install path: standard installer should work." }

if ($OutFile) {
  $stamp = "Claude Desktop readiness - $env:COMPUTERNAME - $(Get-Date -Format s) - admin=$script:IsAdmin"
  @($stamp, '') + ($script:Results | ForEach-Object {
    if ($_.Status) { "[{0}] {1,-34} {2}" -f $_.Status, $_.Name, $_.Detail } else { "`n$($_.Name)" }
  }) + @('', $line) | Set-Content -Path $OutFile -Encoding UTF8
  Write-Host "`nReport written to $OutFile"
}
