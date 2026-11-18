# build-pyinst.ps1 -- PyInstaller STANDALONE build (folder output, which PyInstaller calls --onedir), shaped EXACTLY like the
# Nuitka one, and kept separate from the real PyInstaller release.
#
# Why this script exists: tools\build-nuitka.ps1 produces
#     build\release-nuitka\WebHMI-Designer-Nuitka-<ver>\   exe + DLLs + app\ + frp\ + logs\
# so that the two packers can be compared side by side. This script produces the same SHAPE
# of folder from PyInstaller standalone mode (PyInstaller calls this --onedir):
#     build\release-pyinst\WebHMI-Designer-PyInstaller-<ver>\  exe + _internal\ + app\ + frp\ + logs\
#
# Difference that cannot be removed: PyInstaller hard-codes the "exe + _internal\" runtime
# split (the bootloader looks for _internal next to the exe; the DLLs cannot be flattened the
# way Nuitka does it). Everything else -- exe name, app\ next to the exe, frp\, logs\, version
# metadata -- is identical, so the two folders can be dropped on the same test machine and
# compared (see packaging\packaging-av-checklist.md).
#
# It deliberately NEVER writes into build\release, build\stage, build\pyinst or build\pywork:
# those hold the artifacts the field machines have been getting, and this build must not be
# able to disturb them.
#
#   .\tools\build-pyinst.ps1              standalone folder into build\release-pyinst\
#   .\tools\build-pyinst.ps1 -Clean       wipe build\pyinst* first (full rebuild)
#
# POLICY (house rule): both production lines -- Nuitka and PyInstaller -- always build
# STANDALONE (folder). NEVER produce a onefile / single-exe build unless the user asks for it
# explicitly: onefile self-extracts into %TEMP% on every start, which is the exact behaviour
# AV heuristics are trained on, and it starts seconds slower.
#
# ASCII ONLY on purpose -- Windows PowerShell 5.1 reads a .ps1 as ANSI without a BOM and every
# Chinese literal would break the parser (same rule as build-release.ps1 / build-nuitka.ps1).
[CmdletBinding()]
param(
  [string]$Python = 'python',
  [switch]$Clean,
  # Signing ON by default: without a certificate it only prints a warning (tools\sign.ps1).
  [switch]$NoSign
)

$ErrorActionPreference = 'Continue'   # PyInstaller writes all of its logging to stderr
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$OutRoot   = Join-Path $root 'build\release-pyinst'
$PyDist    = Join-Path $root 'build\pyinst-dir'
$PyWork    = Join-Path $root 'build\pyinst-dir\work'
$AppStage  = Join-Path $root 'build\pyinst-stage\app'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Die($msg) { throw $msg }

# ---- 0. version (same single source of truth as both other builds) ----
$src = Get-Content (Join-Path $root 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $src.version
if (-not $ver) { Die 'version.json has no "version"' }
$v4 = ($ver -split '\.'); while ($v4.Count -lt 4) { $v4 += '0' }
$v4str = ($v4 -join '.')
Step "PyInstaller standalone build of V$ver (separate output: build\release-pyinst)"

if ($Clean) {
  Step 'Clean'
  foreach ($p in @($PyDist, (Join-Path $root 'build\pyinst-stage'), $OutRoot)) {
    Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---- 1. syntax gate ----
Step 'Syntax check'
& $Python 'tools\check-syntax.py' 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Die 'syntax check failed' }

# ---- 2. stage app\ (identical rules to build-release.ps1 / build-nuitka.ps1) ----
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

$leak = @()
foreach ($mustNot in @('server\data', 'server\server', 'logs', 'out', 'build', 'test', '.git', 'packaging', 'tools')) {
  if (Test-Path (Join-Path $AppStage $mustNot)) { $leak += $mustNot }
}
$leak += (Get-ChildItem $AppStage -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName.Substring($AppStage.Length + 1) })
if ($leak.Count -gt 0) { Die ("app\ contains files that must never ship: " + (($leak | Select-Object -First 8) -join ', ')) }
Write-Host "  app\: $((Get-ChildItem $AppStage -Recurse -File).Count) files, clean"

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null

# ---- 3. version metadata for the exe, generated from version.json ----
# Nuitka takes --file-version on the command line; PyInstaller reads a version_info.txt. It is
# generated into the build dir (never editing the tracked packaging\version_info.txt) so the
# exe properties can never drift from version.json after a version bump.
Step 'Version metadata'
$viFile = Join-Path $root 'build\pyinst-stage\version_info.txt'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $viFile) | Out-Null
$vi = @"
VSVersionInfo(
  ffi=FixedFileInfo(filevers=($($v4[0]), $($v4[1]), $($v4[2]), $($v4[3])), prodvers=($($v4[0]), $($v4[1]), $($v4[2]), $($v4[3])), mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[StringFileInfo([StringTable('080404B0', [
      StringStruct('CompanyName', 'xiaoen'),
      StringStruct('LegalCopyright', 'xiaoen'),
      StringStruct('FileDescription', 'WebHMI Designer'),
      StringStruct('FileVersion', '$ver'),
      StringStruct('ProductName', 'WebHMI Designer'),
      StringStruct('ProductVersion', '$ver'),
      StringStruct('OriginalFilename', 'WebHMIDesigner.exe')])]),
    VarFileInfo([VarStruct('Translation', [2052, 1200])])]
)
"@
Set-Content -Path $viFile -Value $vi -Encoding ASCII
Write-Host "  version_info: $v4str -> $viFile"

# ---- 4. shell (PyInstaller STANDALONE = folder output, a.k.a. --onedir) ----
# Reuses packaging\WebHMIDesigner.spec unchanged: onedir, upx=False, console=False, business
# code excluded so that app\ stays updatable. Only distpath/workpath are redirected.
Step 'Building shell (PyInstaller standalone)'
$sw = [Diagnostics.Stopwatch]::StartNew()
$env:HMI_VERSION_FILE = $viFile
$pargs = @(
  '-m', 'PyInstaller', 'packaging\WebHMIDesigner.spec',
  '--noconfirm',
  "--distpath=$PyDist",
  "--workpath=$PyWork"
)
if ($Clean) { $pargs += '--clean' }
& $Python @pargs 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Die 'PyInstaller shell build failed' }
Write-Host ("  elapsed {0:N0}s" -f $sw.Elapsed.TotalSeconds)

$distDir = Join-Path $PyDist 'WebHMIDesigner'
$exe = Join-Path $distDir 'WebHMIDesigner.exe'
if (-not (Test-Path $exe)) { Die "shell exe not produced: $exe" }

# ---- 5. sign BEFORE assembling, so folder / installer payload / installed file share one signature ----
if (-not $NoSign) {
  Step 'Signing shell exe'
  $sigOk = & (Join-Path $PSScriptRoot 'sign.ps1') -Path $exe -Description 'WebHMI Designer'
  if (-not $sigOk) { Write-Host '  (continuing unsigned -- see packaging\packaging-av-checklist.md)' -ForegroundColor Yellow }
}

# ---- 6. assemble the folder, same shape as build\release-nuitka\WebHMI-Designer-Nuitka-<ver>\ ----
Step 'Assembling runnable folder'
$ShellOut = Join-Path $OutRoot "WebHMI-Designer-PyInstaller-$ver"
Remove-Item $ShellOut -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $ShellOut | Out-Null
Copy-Item (Join-Path $distDir '*') $ShellOut -Recurse -Force
Copy-Item $AppStage (Join-Path $ShellOut 'app') -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $ShellOut 'logs') | Out-Null
$frpSrc = Join-Path $root 'packaging\frp'
if (Test-Path (Join-Path $frpSrc 'frpc.exe')) {
  Copy-Item $frpSrc (Join-Path $ShellOut 'frp') -Recurse -Force
} else {
  Write-Host '  WARN: packaging\frp\frpc.exe missing -- remote access (FRP) will not work' -ForegroundColor Yellow
}

# gates: the folder must be self-sufficient and must not ship field data
if (-not (Test-Path (Join-Path $ShellOut 'app\server\hmi_desktop.py'))) { Die 'assembled folder has no app\server\hmi_desktop.py' }
if (-not (Test-Path (Join-Path $ShellOut '_internal'))) { Write-Host '  WARN: no _internal\ -- unexpected for standalone' -ForegroundColor Yellow }
if (Test-Path (Join-Path $ShellOut 'app\server\data')) { Die 'assembled folder contains app\server\data' }
Get-ChildItem $ShellOut -Recurse -Include '*.pyc', '*.pyo' -File -ErrorAction SilentlyContinue | Remove-Item -Force
$files = (Get-ChildItem $ShellOut -Recurse -File).Count
$mb = ((Get-ChildItem $ShellOut -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host ("  {0}: {1:N1} MB, {2} files" -f $ShellOut, $mb, $files)

# ---- 7. report: this build next to the Nuitka one, same table shape ----
Step 'Done'
$rows = @()
$rows += [pscustomobject]@{ kind = 'PyInstaller shell exe'; path = $exe; mb = [math]::Round((Get-Item $exe).Length / 1MB, 2) }
$rows += [pscustomobject]@{ kind = 'PyInstaller folder'; path = $ShellOut; mb = [math]::Round($mb, 2) }
$nkFolder = Join-Path $root "build\release-nuitka\WebHMI-Designer-Nuitka-$ver"
if (Test-Path $nkFolder) {
  $rows += [pscustomobject]@{ kind = 'Nuitka folder'; path = $nkFolder; mb = [math]::Round(((Get-ChildItem $nkFolder -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2) }
}
$rows | Format-Table -AutoSize kind, mb, path | Out-String -Width 200 | Write-Host
Write-Host ''
Write-Host ("  {0,-46} {1:N1} MB  sha256={2}" -f 'WebHMIDesigner.exe', ((Get-Item $exe).Length / 1MB), (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower())
