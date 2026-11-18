# build-nuitka.ps1 -- Nuitka build, kept COMPLETELY SEPARATE from the PyInstaller release.
#
# Why this script exists: the PyInstaller artifacts (build\pyinst, build\release) are what
# field machines have been getting so far, and the question on the table is whether a
# Nuitka-built package trips antivirus / SmartScreen less often. So this script must never
# write into build\release, build\pyinst or build\stage -- everything lands in
# build\nuitka* / build\release-nuitka, and the two builds can sit side by side and be
# uploaded to VirusTotal together for an apples-to-apples comparison.
#
#   .\tools\build-nuitka.ps1                  shell + installer, into build\release-nuitka\
#   .\tools\build-nuitka.ps1 -SkipInstaller   shell folder only (fast iteration)
#   .\tools\build-nuitka.ps1 -Clean           wipe build\nuitka* first (full recompile)
#
# Output (build\release-nuitka\):
#   WebHMI-Designer-Nuitka-<ver>\            runnable folder: WebHMIDesigner.exe + DLLs + app\ + frp\
#   WebHMI-Designer-Nuitka-Setup-<ver>.exe   onefile installer (same packaging/installer.py)
#
# Layering is unchanged from the PyInstaller build: the exe is only the shell (Python
# runtime + pywebview + pythonnet), business code stays in app\ as plain .py files and is
# loaded from disk by packaging/launcher.py, so daily updates still only replace app\.
#
# ASCII ONLY on purpose -- Windows PowerShell 5.1 reads a .ps1 as ANSI without a BOM and
# every Chinese literal would break the parser (same rule as build-release.ps1).
[CmdletBinding()]
param(
  [string]$Python = 'python',
  [switch]$SkipInstaller,
  [switch]$SkipShell,
  [switch]$Clean,
  # Signing on purpose is ON by default: an unsigned exe is the biggest remaining
  # false-positive factor, and the day a certificate is imported the build starts
  # signing itself without any other change (see tools\sign.ps1). Without a cert the
  # step just prints a warning and carries on, so this never breaks a build.
  [switch]$NoSign
)

$ErrorActionPreference = 'Continue'   # Nuitka writes its logs to stderr; see build-release.ps1
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$OutRoot   = Join-Path $root 'build\release-nuitka'
$NuitkaWork = Join-Path $root 'build\nuitka'
$AppStage  = Join-Path $root 'build\nuitka-stage\app'
$Payload   = Join-Path $root 'build\nuitka-stage\payload'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Die($msg) { throw $msg }

# ---- 0. version (same single source of truth as the PyInstaller build) ----
$src = Get-Content (Join-Path $root 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $src.version
if (-not $ver) { Die 'version.json has no "version"' }
$v4 = ($ver -split '\.'); while ($v4.Count -lt 4) { $v4 += '0' }
$v4str = ($v4 -join '.')
Step "Nuitka build of V$ver (separate output: build\release-nuitka)"

if ($Clean) {
  Step 'Clean'
  foreach ($p in @($NuitkaWork, (Join-Path $root 'build\nuitka-stage'), $OutRoot)) {
    Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---- 1. syntax gate (never ship a broken package) ----
Step 'Syntax check'
& $Python 'tools\check-syntax.py' 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Die 'syntax check failed' }

# ---- 2. stage app\ (identical rules to build-release.ps1 -- keep the two in sync) ----
Step "Staging app\ -> $AppStage"
Remove-Item $AppStage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $AppStage | Out-Null
foreach ($it in @('index.html', 'version.json', 'README.md', 'favicon.ico', 'css', 'js', 'server', 'docs')) {
  $s = Join-Path $root $it
  if (-not (Test-Path $s)) { continue }
  if ((Get-Item $s).PSIsContainer) { Copy-Item $s (Join-Path $AppStage $it) -Recurse -Force }
  else { Copy-Item $s (Join-Path $AppStage $it) -Force }
}
foreach ($junk in @('server\data', 'logs', '__pycache__', '.pytest_cache', 'out', 'build')) {
  $p = Join-Path $AppStage $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Get-ChildItem $AppStage -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
Get-ChildItem $AppStage -Recurse -Include '*.pyc', '*.pyo' -File -ErrorAction SilentlyContinue | Remove-Item -Force
if (-not (Test-Path (Join-Path $AppStage 'server\hmi_desktop.py'))) { Die 'app\server\hmi_desktop.py is missing' }
Write-Host "  app\: $((Get-ChildItem $AppStage -Recurse -File).Count) files"

# hard gate: field data / caches / dev dirs must never ship (same list as build-release.ps1)
$leak = @()
foreach ($mustNot in @('server\data', 'server\server', 'logs', 'out', 'build', 'test', '.git', 'packaging', 'tools')) {
  if (Test-Path (Join-Path $AppStage $mustNot)) { $leak += $mustNot }
}
$leak += (Get-ChildItem $AppStage -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName.Substring($AppStage.Length + 1) })
if ($leak.Count -gt 0) { Die ("app\ contains files that must never ship: " + (($leak | Select-Object -First 8) -join ', ')) }
Write-Host '  clean (no server\data / no __pycache__ / no dev dirs)'

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null

# ---- 3. shell exe (Nuitka standalone) ----
# --mode=standalone, NOT onefile: the app is "shell + app\" and the shell must have a stable
# install-dir layout. A onefile shell would unpack itself to %TEMP% on every start (slow, and
# exactly the "self-extracting executable" pattern AV heuristics dislike most).
$ShellDist = Join-Path $NuitkaWork 'launcher.dist'
if (-not $SkipShell) {
  Step 'Building shell (Nuitka standalone)'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $nargs = @(
    '-m', 'nuitka',
    '--mode=standalone',
    '--assume-yes-for-downloads',
    '--msvc=latest',
    "--output-dir=$NuitkaWork",
    '--output-filename=WebHMIDesigner.exe',
    '--windows-console-mode=disable',
    '--windows-icon-from-ico=packaging\hmi.ico',
    '--company-name=xiaoen',
    '--product-name=WebHMI Designer',
    '--file-description=WebHMI Designer',
    "--file-version=$v4str",
    "--product-version=$v4str",
    '--copyright=xiaoen',
    # runtime pieces the app needs but that launcher.py never imports statically:
    # it loads app\server\hmi_desktop.py from disk, and THAT file imports webview + asyncua.
    '--include-package=webview',
    '--include-package=pythonnet',
    '--include-package=clr_loader',
    '--include-package=asyncua',
    # data files (js\lib\nuget DLLs) -- without these pywebview cannot start at runtime:
    #   webview\lib\Microsoft.Web.WebView2.*.dll + runtimes\win-x64\native\WebView2Loader.dll
    #   pythonnet\runtime\Python.Runtime.dll / clr_loader\ffi\dlls\amd64\ClrLoader.dll
    '--include-package-data=webview',
    '--include-package-data=pythonnet',
    '--include-package-data=clr_loader',
    '--include-package-data=asyncua',
    # Nuitka ships an ALWAYS-ENABLED 'pywebview' plugin. On Windows it decides "do not follow"
    # for the other platforms' backends, so a blanket --include-package=webview would collide:
    #   FATAL: pywebview: Conflict between user and plugin decision for module 'webview.platforms.android'.
    # Spell its exclusions out here so the user decision matches the plugin decision (the 4
    # backends below are the ones the plugin rejects on Windows).
    '--nofollow-import-to=webview.platforms.android',
    '--nofollow-import-to=webview.platforms.cocoa',
    '--nofollow-import-to=webview.platforms.gtk',
    '--nofollow-import-to=webview.platforms.qt',
    # never needed; each one only inflates the shell (tkinter alone drags in TCL/TK)
    '--nofollow-import-to=tkinter',
    '--nofollow-import-to=unittest',
    '--nofollow-import-to=pydoc',
    '--nofollow-import-to=test',
    '--nofollow-import-to=pytest',
    '--nofollow-import-to=numpy',
    '--nofollow-import-to=matplotlib',
    '--nofollow-import-to=scipy',
    '--nofollow-import-to=pandas',
    '--nofollow-import-to=PyQt5',
    '--nofollow-import-to=PySide6',
    'packaging\launcher.py'
  )
  & $Python @nargs 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Die 'Nuitka shell build failed' }
  Write-Host ("  elapsed {0:N0}s" -f $sw.Elapsed.TotalSeconds)
}
$ShellExe = Join-Path $ShellDist 'WebHMIDesigner.exe'
if (-not (Test-Path $ShellExe)) { Die "shell exe not produced: $ShellExe" }
$shellMB = (Get-ChildItem $ShellDist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("  shell: {0:N1} MB, {1} files" -f $shellMB, (Get-ChildItem $ShellDist -Recurse -File).Count)

# ---- 3b. sign the shell exe BEFORE it is copied into the payload ----
# Signing the dist exe (not the copies) means the portable folder, the installer payload
# and the installed file all carry the SAME signature. Without a certificate this is a
# no-op that only prints a warning -- see tools\sign.ps1 for the reasoning.
if (-not $NoSign) {
  Step 'Signing shell exe'
  $sigOk = & (Join-Path $PSScriptRoot 'sign.ps1') -Path $ShellExe -Description 'WebHMI Designer'
  if (-not $sigOk) { Write-Host '  (continuing unsigned -- see packaging\packaging-av-checklist.md)' -ForegroundColor Yellow }
}

# ---- 4. assemble the runnable folder (build\release-nuitka\...\<ver>\) ----
Step 'Assembling runnable folder'
$ShellOut = Join-Path $OutRoot "WebHMI-Designer-Nuitka-$ver"
Remove-Item $ShellOut -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $ShellOut | Out-Null
Copy-Item (Join-Path $ShellDist '*') $ShellOut -Recurse -Force
Copy-Item $AppStage (Join-Path $ShellOut 'app') -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $ShellOut 'logs') | Out-Null

# FRP client ships with the shell, not with app\ (see build-release.ps1 for the reasoning)
$frpSrc = Join-Path $root 'packaging\frp'
if (Test-Path (Join-Path $frpSrc 'frpc.exe')) {
  Copy-Item $frpSrc (Join-Path $ShellOut 'frp') -Recurse -Force
} else {
  Write-Host '  WARN: packaging\frp\frpc.exe missing -- remote access (FRP) will not work' -ForegroundColor Yellow
}
Write-Host ("  {0}: {1:N1} MB" -f $ShellOut, ((Get-ChildItem $ShellOut -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))

# ---- 5. installer (Nuitka onefile, same installer.py as the PyInstaller build) ----
if (-not $SkipInstaller) {
  Step 'Building installer payload'
  Remove-Item $Payload -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Payload | Out-Null
  # PS 5.1: Copy-Item with a wildcard source and a NOT-YET-EXISTING destination folder
  # throws "Container cannot be copied onto existing leaf item" for every subdirectory
  # (silently skipping it, exit code stays 0) -- the payload then misses clr_loader/
  # pythonnet/webview/pytz/cryptography and the installed app cannot start.
  # Pre-creating the destination folder is the fix.
  New-Item -ItemType Directory -Force -Path (Join-Path $Payload 'WebHMIDesigner') | Out-Null
  Copy-Item (Join-Path $ShellDist '*') (Join-Path $Payload 'WebHMIDesigner') -Recurse -Force
  if (Test-Path (Join-Path $frpSrc 'frpc.exe')) {
    Copy-Item $frpSrc (Join-Path $Payload 'WebHMIDesigner\frp') -Recurse -Force
  }
  Copy-Item $AppStage (Join-Path $Payload 'app') -Recurse -Force
  # strip caches one more time: an empty __pycache__ dir still ends up inside the exe
  Get-ChildItem $Payload -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
  Get-ChildItem $Payload -Recurse -Include '*.pyc', '*.pyo' -File -ErrorAction SilentlyContinue | Remove-Item -Force
  if (Test-Path (Join-Path $Payload 'app\server\data')) { Die 'payload still contains app\server\data' }
  # hard gate: a silently short payload produces a 9 MB installer that "installs" a broken app
  $payloadFiles2 = (Get-ChildItem (Join-Path $Payload 'WebHMIDesigner') -Recurse -File -ErrorAction SilentlyContinue).Count
  $distFiles = (Get-ChildItem $ShellDist -Recurse -File).Count
  if ($payloadFiles2 -lt $distFiles) { Die "payload\WebHMIDesigner incomplete: $payloadFiles2 files, dist has $distFiles" }
  Write-Host "  payload: $payloadFiles2 files under WebHMIDesigner\ + app\"

  # The installer is a onefile by design ("one file, double-click, done") and that is also
  # the artifact most likely to be quarantined on the way to a customer -- hence Nuitka here
  # too, so the comparison covers both the shell and the setup exe.
  Step 'Building installer (Nuitka onefile)'
  $sw2 = [Diagnostics.Stopwatch]::StartNew()
  # Nuitka's tk-inter plugin is NOT on by default: without it tcl\tk data files are missing
  # and the installer dies at "import tkinter".
  $nargs2 = @(
    '-m', 'nuitka',
    '--mode=onefile',
    '--assume-yes-for-downloads',
    '--msvc=latest',
    '--enable-plugin=tk-inter',
    "--output-dir=$NuitkaWork\installer",
    '--output-filename=WebHMI-Designer-Nuitka-Setup.exe',
    '--windows-console-mode=disable',
    '--windows-uac-admin',
    '--windows-icon-from-ico=packaging\hmi.ico',
    '--company-name=xiaoen',
    '--product-name=WebHMI Designer Setup',
    '--file-description=WebHMI Designer Setup',
    "--file-version=$v4str",
    "--product-version=$v4str",
    '--copyright=xiaoen',
    # --include-raw-dir (NOT --include-data-dir!): Nuitka's data-dir option silently
    # ignores ".py .pyc .pyd .dll .exe .bin .so ..." (freezer\IncludedDataFiles.py:
    # default_ignored_suffixes = "By default ignore all things that are code"),
    # which dropped WebHMIDesigner.exe, every .dll/.pyd AND the whole app\server\*.py
    # from the payload -- the installer then shipped 9 MB and died at install time with
    # "installer payload incomplete". --include-raw-dir copies the tree verbatim (raw=True).
    "--include-raw-dir=$Payload=payload",
    '--nofollow-import-to=webview',
    '--nofollow-import-to=asyncua',
    '--nofollow-import-to=pythonnet',
    '--nofollow-import-to=clr_loader',
    'packaging\installer.py'
  )
  & $Python @nargs2 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Die 'Nuitka installer build failed' }
  # hard gate: the onefile dist keeps a copy of the packed payload -- if it is short,
  # the exe would "install" a broken app. Compare against the source payload file count.
  $instDist = Join-Path $NuitkaWork 'installer\installer.dist\payload'
  if (Test-Path $instDist) {
    $staged = (Get-ChildItem $Payload -Recurse -File).Count
    $packed = (Get-ChildItem $instDist -Recurse -File).Count
    Write-Host "  packed payload: $packed files (source $staged)"
    if ($packed -lt $staged) { Die "installer payload incomplete: $packed of $staged files packed into the exe" }
  } else {
    Write-Host '  WARN: installer.dist not kept -- cannot verify packed payload' -ForegroundColor Yellow
  }
  $setupBuilt = Join-Path $NuitkaWork "installer\WebHMI-Designer-Nuitka-Setup.exe"
  if (-not (Test-Path $setupBuilt)) { Die "installer not produced: $setupBuilt" }
  # sign the onefile BEFORE the hash is reported, so the SHA256 handed to VirusTotal
  # is the hash of what actually ships
  if (-not $NoSign) {
    Step 'Signing setup exe'
    $sigOk2 = & (Join-Path $PSScriptRoot 'sign.ps1') -Path $setupBuilt -Description 'WebHMI Designer Setup'
    if (-not $sigOk2) { Write-Host '  (setup is unsigned -- see packaging\packaging-av-checklist.md)' -ForegroundColor Yellow }
  }
  $setupName = "WebHMI-Designer-Nuitka-Setup-$ver.exe"
  $setupPath = Join-Path $OutRoot $setupName
  Remove-Item $setupPath -Force -ErrorAction SilentlyContinue
  Move-Item $setupBuilt $setupPath -Force
  Write-Host ("  {0}  {1:N1} MB  ({2:N0}s)" -f $setupName, ((Get-Item $setupPath).Length / 1MB), $sw2.Elapsed.TotalSeconds)
}

# ---- 6. report (sizes + sha256; the PyInstaller numbers are printed for comparison) ----
Step 'Done'
$rows = @()
$oldSetup = Join-Path $root "build\release\WebHMI-Designer-Setup-$ver.exe"
$oldExe = Join-Path $root 'build\pyinst\WebHMIDesigner\WebHMIDesigner.exe'
if (Test-Path $oldExe) {
  $rows += [pscustomobject]@{ kind = 'PyInstaller shell exe'; path = $oldExe; mb = [math]::Round((Get-Item $oldExe).Length / 1MB, 2) }
}
$rows += [pscustomobject]@{ kind = 'Nuitka shell exe'; path = $ShellExe; mb = [math]::Round((Get-Item $ShellExe).Length / 1MB, 2) }
$rows += [pscustomobject]@{ kind = 'Nuitka shell folder'; path = $ShellOut; mb = [math]::Round(((Get-ChildItem $ShellOut -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2) }
if (Test-Path $oldSetup) {
  $rows += [pscustomobject]@{ kind = 'PyInstaller setup'; path = $oldSetup; mb = [math]::Round((Get-Item $oldSetup).Length / 1MB, 2) }
}
if (Test-Path (Join-Path $OutRoot "WebHMI-Designer-Nuitka-Setup-$ver.exe")) {
  $p = Join-Path $OutRoot "WebHMI-Designer-Nuitka-Setup-$ver.exe"
  $rows += [pscustomobject]@{ kind = 'Nuitka setup'; path = $p; mb = [math]::Round((Get-Item $p).Length / 1MB, 2) }
}
$rows | Format-Table -AutoSize kind, mb, path | Out-String -Width 200 | Write-Host
Write-Host ''
Get-ChildItem $OutRoot -File -ErrorAction SilentlyContinue | ForEach-Object {
  "  {0,-46} {1:N1} MB  sha256={2}" -f $_.Name, ($_.Length / 1MB), (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower().Substring(0, 16)
}
