# build-release.ps1 -- one-click build + publish (ASCII ONLY, on purpose)
#
# Why ASCII only: this machine's shell is Windows PowerShell 5.1, which reads a .ps1
# as ANSI/GBK unless the file has a UTF-8 BOM -- and any editor that rewrites the file
# can drop that BOM, at which point every Chinese string literal breaks the parser.
# Same reason the .bat files in this repo are ASCII only. Chinese docs live in
# packaging/*.py and README.md instead.
#
#   .\tools\build-release.ps1                 build only -> build\release\
#   .\tools\build-release.ps1 -Publish        build, then upload to the release repo
#   .\tools\build-release.ps1 -SkipExe        app code package only (shell unchanged)
#
# Output (build\release\):
#   WebHMI-Designer-Setup-<ver>.exe        full installer (user picks the install dir)
#   WebHMI-Designer-<ver>-app.zip         code package used by "update now" (a few MB)
#   version.json                       manifest (app_zip sha256 + min_launcher) -> release repo
#
# Publish target: http://124.221.183.24:3000/xiaoen/hmi-designer -- the PUBLIC repo. The V2
# SOURCE lives in the private repo xiaoen/hmi-designer-v2 (login required); only the binaries
# and the manifest go public, so field machines can download without an account.
#   release/version-v2.json -> committed to the public repo (the V2 update channel;
#                              1.x has its own release/version.json -- never share the path)
#   big files               -> Release assets under tag v<ver> (exe + app zip)
#   credentials             -> env vars HMI_GIT_USER / HMI_GIT_PASS (never hardcode)
#
# Layering reminder: a running exe cannot overwrite itself (Windows locks it), so the
# app ships as "shell (exe + _internal)" + "app\ (updatable code)". Daily updates only
# replace app\ -- no reinstall, no UAC. See packaging/launcher.py.
[CmdletBinding()]
param(
  [switch]$Publish,
  [switch]$SkipExe,
  # Packaging interpreter must be a STABLE release: this dev box's `py -3.10` is 3.10.0b1
  # (beta) and PyInstaller crashes scanning its bytecode. System python 3.11 works.
  [string]$Python = 'python',
  [string]$Iscc = '',
  # Signing is ON by default (see tools\sign.ps1): no certificate -> warning + carry on,
  # certificate imported -> shell exe and setup exe are signed automatically.
  [switch]$NoSign
)

# NOTE: do NOT use ErrorActionPreference='Stop' here. Windows PowerShell 5.1 turns any
# native command's stderr output into a NativeCommandError, and PyInstaller writes all of
# its INFO logs to stderr -- with 'Stop' the build dies right after "PyInstaller: 6.x".
# Every native call below checks $LASTEXITCODE explicitly instead.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$Release = Join-Path $root 'build\release'
$Stage = Join-Path $root 'build\stage'
$AppStage = Join-Path $Stage 'app'
$PyInst = Join-Path $root 'build\pyinst'
$PyWork = Join-Path $root 'build\pywork'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ---- 0. version (single source of truth: version.json) ----
$verFile = Join-Path $root 'version.json'
$src = Get-Content $verFile -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $src.version
if (-not $ver) { throw 'version.json has no "version"' }
$minLauncher = if ($src.min_launcher) { $src.min_launcher } else { '1.0.0' }
Step "Building V$ver (min_launcher $minLauncher)"

# ---- 1. syntax gate (never ship a broken package) ----
Step 'Syntax check'
& $Python 'tools\check-syntax.py' 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }

# ---- 2. stage app\ (minimum set needed to run) ----
Step "Staging app\ -> $AppStage"
Remove-Item $AppStage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $AppStage | Out-Null
foreach ($it in @('index.html', 'version.json', 'README.md', 'favicon.ico', 'css', 'js', 'server', 'docs')) {
  $s = Join-Path $root $it
  if (-not (Test-Path $s)) { continue }
  if ((Get-Item $s).PSIsContainer) { Copy-Item $s (Join-Path $AppStage $it) -Recurse -Force }
  else { Copy-Item $s (Join-Path $AppStage $it) -Force }
}
# never ship field data / caches / logs inside the package.
# NOTE: recursive on purpose -- after the backend was split into server\core\, __pycache__
# also appears in SUBdirectories, and an empty __pycache__ dir still lands in the zip
# (that is how "包里怎么有一堆 __pycache__" happened). Same for stray dirs.
foreach ($junk in @('server\data', 'logs', '__pycache__', '.pytest_cache', 'out', 'build')) {
  $p = Join-Path $AppStage $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Get-ChildItem $AppStage -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
Get-ChildItem $AppStage -Recurse -Include '*.pyc', '*.pyo' -File -ErrorAction SilentlyContinue | Remove-Item -Force
$appFiles = (Get-ChildItem $AppStage -Recurse -File).Count
Write-Host "  app\: $appFiles files"
if (-not (Test-Path (Join-Path $AppStage 'server\hmi_desktop.py'))) { throw 'app\server\hmi_desktop.py is missing' }

# ---- 2b. hard gate: nothing that must never ship may be inside app\ ----
# 现场数据（server\data：客户工程 / 口令 / 会话）、缓存（__pycache__ / *.pyc）、
# 以及 build\out\test\logs 这类开发目录，一个都不许进包（否则轻则包变大，重则把客户
# 工程和口令一起发出去）。这里是**打包前的一次硬验收**，不通过就中断，别等发出去才发现。
$leak = @()
foreach ($mustNot in @('server\data', 'server\server', 'logs', 'out', 'build', 'test', '.git', 'packaging', 'tools')) {
  if (Test-Path (Join-Path $AppStage $mustNot)) { $leak += $mustNot }
}
$leak += (Get-ChildItem $AppStage -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName.Substring($AppStage.Length + 1) })
$leak += (Get-ChildItem $AppStage -Recurse -File -Include '*.pyc', '*.pyo' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName.Substring($AppStage.Length + 1) })
if ($leak.Count -gt 0) {
  throw ("app\ contains files that must never ship: " + (($leak | Select-Object -First 8) -join ', '))
}
Write-Host '  clean (no server\data / no __pycache__ / no dev dirs)'

New-Item -ItemType Directory -Force -Path $Release | Out-Null

# ---- 3. app code package (used by "update now") ----
Step 'Building app code package'
$zipName = "WebHMI-Designer-$ver-app.zip"
$zipPath = Join-Path $Release $zipName
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
# no wrapper directory: the updater extracts paths relative to app\
Compress-Archive -Path (Join-Path $AppStage '*') -DestinationPath $zipPath -CompressionLevel Optimal
$zipSha = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
$zipSize = (Get-Item $zipPath).Length
Write-Host ("  {0}  {1:N0} bytes  sha256={2}" -f $zipName, $zipSize, $zipSha.Substring(0, 16))

# ---- 4. shell (exe) + installer ----
$setupName = "WebHMI-Designer-Setup-$ver.exe"
$setupPath = Join-Path $Release $setupName
if (-not $SkipExe) {
  Step 'Building shell (PyInstaller onedir)'
  $vi = Join-Path $root 'packaging\version_info.txt'
  $v4 = ($ver -split '\.'); while ($v4.Count -lt 4) { $v4 += '0' }
  $viBody = @"
VSVersionInfo(
  ffi=FixedFileInfo(filevers=($($v4 -join ', ')), prodvers=($($v4 -join ', ')), mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
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
  [IO.File]::WriteAllText($vi, $viBody, (New-Object Text.UTF8Encoding($false)))
  $env:HMI_VERSION_FILE = $vi
  Remove-Item $PyInst, $PyWork -Recurse -Force -ErrorAction SilentlyContinue
  & $Python -m PyInstaller 'packaging\WebHMIDesigner.spec' --noconfirm --distpath $PyInst --workpath $PyWork 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'PyInstaller shell build failed' }
  $exe = Join-Path $PyInst 'WebHMIDesigner\WebHMIDesigner.exe'
  if (-not (Test-Path $exe)) { throw "shell exe not produced: $exe" }
  $shellMB = (Get-ChildItem (Join-Path $PyInst 'WebHMIDesigner') -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
  Write-Host ("  shell: {0:N1} MB" -f $shellMB)

  # Sign the dist exe BEFORE it is copied into the installer payload, so the installed
  # file and the payload copy carry the same signature.
  if (-not $NoSign) {
    Step 'Signing shell exe'
    $sigOk = & (Join-Path $PSScriptRoot 'sign.ps1') -Path $exe -Description 'WebHMI Designer'
    if (-not $sigOk) { Write-Host '  (continuing unsigned -- see packaging\packaging-av-checklist.md)' -ForegroundColor Yellow }
  }

  Step 'Assembling installer payload'
  Copy-Item (Join-Path $PyInst 'WebHMIDesigner') $Stage -Recurse -Force

  # ---- FRP client (frpc.exe) -> <install>\frp\ -------------------------------------
  # Ships with the SHELL (the installer), NOT inside app\: frpc.exe is ~16 MB while the
  # daily update package is ~3 MB -- bundling it into the code package would make every
  # "update now" re-download those 16 MB for nothing. frp is Apache-2.0 (LICENSE travels
  # next to the exe). The app locates it via server/core/frp.py find_frpc():
  #   env HMI_FRPC > <install>\frp\frpc.exe > <app>\frp\ > PATH
  $frpSrc = Join-Path $root 'packaging\frp'
  if (-not (Test-Path (Join-Path $frpSrc 'frpc.exe'))) {
    throw ('packaging\frp\frpc.exe is missing -- the installer has to bundle the FRP client ' +
      '(git pull, or drop frpc.exe there; see packaging\frp\README.md)')
  }
  $frpDst = Join-Path $Stage 'WebHMIDesigner\frp'
  New-Item -ItemType Directory -Force -Path $frpDst | Out-Null
  Copy-Item (Join-Path $frpSrc '*') $frpDst -Recurse -Force
  Write-Host ("  frp: {0:N1} MB (frpc.exe + LICENSE, goes to <install>\frp\)" -f ((Get-ChildItem $frpDst -Recurse -File |
    Measure-Object Length -Sum).Sum / 1MB))

  # Installer: prefer Inno Setup when available (it is the industry standard, but it is
  # only published on GitHub -- unreachable from this build box, and winget hangs for the
  # same reason). Fall back to the built-in installer in packaging/installer.py, which
  # offers the same essentials: user-selectable install dir, shortcuts, uninstaller,
  # and -- most important -- a data dir it never touches.
  if (-not $Iscc) {
    foreach ($c in @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
      if (Test-Path $c) { $Iscc = $c; break }
    }
  }
  if ($Iscc -and (Test-Path $Iscc)) {
    Step 'Compiling installer (Inno Setup)'
    Remove-Item $setupPath -Force -ErrorAction SilentlyContinue
    & $Iscc "/DAppVersion=$ver" "/DStage=$Stage" "/DOutputDir=$Release" 'packaging\WebHMIDesigner.iss' | Select-Object -Last 6
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compile failed' }
  } else {
    Step 'Building installer (built-in, PyInstaller onefile)'
    $payload = Join-Path $Stage 'payload'
    Remove-Item $payload -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $payload | Out-Null
    Copy-Item (Join-Path $PyInst 'WebHMIDesigner') $payload -Recurse -Force
    Copy-Item $AppStage (Join-Path $payload 'app') -Recurse -Force
    foreach ($junk in @('app\server\data', 'app\logs', 'app\server\__pycache__')) {
      $p = Join-Path $payload $junk
      if (Test-Path $p) { Remove-Item $p -Recurse -Force }
    }
    # 递归再清一遍 __pycache__（app\server\core\ 下面也会有；空目录同样会被打进 exe）
    Get-ChildItem $payload -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force
    Get-ChildItem $payload -Recurse -Include '*.pyc', '*.pyo' -File -ErrorAction SilentlyContinue | Remove-Item -Force
    if (Test-Path (Join-Path $payload 'app\server\data')) { throw 'payload still contains app\server\data' }
    $env:HMI_STAGE = $Stage
    Remove-Item $setupPath -Force -ErrorAction SilentlyContinue
    & $Python -m PyInstaller 'packaging\installer.spec' --noconfirm --distpath $Release --workpath (Join-Path $root 'build\pywork-inst') 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'installer build failed' }
    if (Test-Path (Join-Path $Release 'WebHMI-Designer-Setup.exe')) {
      Move-Item (Join-Path $Release 'WebHMI-Designer-Setup.exe') $setupPath -Force
    }
  }
  if (-not (Test-Path $setupPath)) { throw "installer not produced: $setupName" }
  if (-not $NoSign) {
    Step 'Signing setup exe'
    $sigOk2 = & (Join-Path $PSScriptRoot 'sign.ps1') -Path $setupPath -Description 'WebHMI Designer Setup'
    if (-not $sigOk2) { Write-Host '  (setup is unsigned -- see packaging\packaging-av-checklist.md)' -ForegroundColor Yellow }
  }
  Write-Host ("  {0}  {1:N1} MB" -f $setupName, ((Get-Item $setupPath).Length / 1MB))
}

# ---- 5. release manifest ----
Step 'Writing release manifest'
# Everything ships from ONE repo (xiaoen/hmi-designer): source + docs in git,
# installer/code package as Release assets under tag v<ver>, and this manifest.
$repoBase = 'http://124.221.183.24:3000/xiaoen/hmi-designer'
$tag = "v$ver"
$man = [ordered]@{
  app          = $src.app
  version      = $ver
  date         = $src.date
  notes        = $src.notes
  url          = $repoBase
  min_launcher = $minLauncher
  app_zip      = [ordered]@{
    url    = "$repoBase/releases/download/$tag/$zipName"
    file   = $zipName
    sha256 = $zipSha
    size   = $zipSize
  }
}
if (Test-Path $setupPath) {
  $man.setup = [ordered]@{
    url    = "$repoBase/releases/download/$tag/$setupName"
    file   = $setupName
    sha256 = (Get-FileHash $setupPath -Algorithm SHA256).Hash.ToLower()
    size   = (Get-Item $setupPath).Length
  }
}
$manPath = Join-Path $Release 'version.json'
[IO.File]::WriteAllText($manPath, ($man | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Write-Host "  $manPath"

# ---- 6. publish ----
if (-not $Publish) {
  Step 'Done (no -Publish: local output only)'
  Get-ChildItem $Release | ForEach-Object { "  {0,-40} {1:N1} MB" -f $_.Name, ($_.Length / 1MB) }
  Write-Host "`nPublish with:  .\tools\build-release.ps1 -SkipExe -Publish"
  return
}

Step "Publishing to $repoBase (tag $tag)"
$user = $env:HMI_GIT_USER; $pass = $env:HMI_GIT_PASS
if (-not $user -or -not $pass) { throw 'publishing needs env vars HMI_GIT_USER / HMI_GIT_PASS' }
$host_ = 'http://124.221.183.24:3000'
# NOTE: the REST API lives at <host>/api/v1/..., NOT under the repo path. Building it from
# $repoBase yields ".../hmi-designer/api/v1/..." -> 404 on every call (been there).
$api = "$host_/api/v1/repos/xiaoen/hmi-designer"
$hdr = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$user`:$pass")) }

# ErrorActionPreference is 'Continue' in this script (PyInstaller writes to stderr), so every
# API call below must be checked explicitly -- otherwise a 404 sails through as "success".
function Assert-Api($what, $result) {
  if ($null -eq $result) { throw "$what failed (no response)" }
  return $result
}

# NOTE: send API bodies as UTF-8 BYTES, not as a string. Windows PowerShell 5.1 encodes a
# string body with the ANSI code page, so any Chinese in the JSON (commit messages!) reaches
# Gitea as "?????" -- the file content is base64 so it survives, but the messages do not.
function Send-GiteaJson($uri, $method, $obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6))
  return Invoke-RestMethod -Uri $uri -Method $method -Headers $hdr `
    -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 180
}

# Commit one file into the repo (create or update: Gitea needs the current sha to update)
function Push-GiteaFile($apiPath, $localFile, $msg) {
  if (-not (Test-Path $localFile)) { Write-Host "  skip $apiPath (missing locally)"; return }
  $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($localFile))
  $body = @{ content = $content; message = $msg }
  try {
    $cur = Invoke-RestMethod -Uri "$api/contents/$apiPath" -Headers $hdr -TimeoutSec 30
    $body = @{ content = $content; message = $msg; sha = $cur.sha }
  } catch { }
  $null = Assert-Api "upload $apiPath" (Send-GiteaJson "$api/contents/$apiPath" 'Put' $body)
  Write-Host ("  synced: {0}" -f $apiPath)
}

# 6a. manifest -> release/version-v2.json in the PUBLIC repo (xiaoen/hmi-designer).
#
#     WHY the "-v2" name: that repo also hosts the 1.x line, and its own publish script writes
#     release/version.json. Two product lines MUST NOT share one manifest path -- V2 clients
#     reading the 1.x manifest would download 1.x code over their own app layer (a downgrade),
#     and vice versa. So: 1.x -> release/version.json, V2 -> release/version-v2.json.
#     server/core/versioninfo.py points at the -v2 one by default.
#
#     WHY not the root version.json: that is the human-edited version source (version/date/notes)
#     and a dev-box git push overwrites it; the manifest is generated (it carries app_zip sha256).
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($manPath))
$body = @{ content = $b64; message = "release: V$ver manifest (v2 channel)" }
try {
  $cur = Invoke-RestMethod -Uri "$api/contents/release/version-v2.json" -Headers $hdr -TimeoutSec 20
  $body = @{ content = $b64; message = "release: V$ver manifest (v2 channel)"; sha = $cur.sha }
  Write-Host "  release/version-v2.json exists (sha $($cur.sha.Substring(0,8))), updating"
} catch {
  Write-Host '  release/version-v2.json not present yet, creating'
}
$put = Assert-Api 'commit release/version-v2.json' (Send-GiteaJson "$api/contents/release/version-v2.json" 'Put' $body)
Write-Host "  release/version-v2.json committed (sha $($put.content.sha.Substring(0,8)))"

# 6a-2. the download/landing page next to the manifest (also V2-only name: the 1.x page lives at
#       release/README.md and must not be overwritten by a V2 publish)
Push-GiteaFile 'release/README-v2.md' (Join-Path $root 'packaging\release-readme.md') "docs: release page (V$ver)"

# 6b. big files -> release assets (do not bloat git history)
$rel = $null
try { $rel = Invoke-RestMethod -Uri "$api/releases/tags/$tag" -Headers $hdr -TimeoutSec 20 } catch { }
$relBody = @{ tag_name = $tag; name = "WebHMI Designer $ver"; body = $man.notes; draft = $false; target_commitish = 'master' }
if (-not $rel) {
  # ⚠ 必须走 Send-GiteaJson（UTF-8 字节）：以前这里用 -Body $relBody（字符串），
  #    PS 5.1 会按 ANSI 编码 → 发布页上的中文更新说明全变成 "?????"（现场看到的就是这个）
  $rel = Assert-Api 'create release' (Send-GiteaJson "$api/releases" 'Post' $relBody)
  Write-Host "  release $tag created (id $($rel.id))"
} else {
  # 已存在的 release 也要把说明刷新一遍：内容一样时 Gitea 不会报错，改了就能修好历史发布页
  $rel = Assert-Api 'update release' (Send-GiteaJson "$api/releases/$($rel.id)" 'Patch' $relBody)
  Write-Host "  release $tag exists (id $($rel.id)), body refreshed"
}

foreach ($f in @($zipPath, $setupPath)) {
  if (-not (Test-Path $f)) { continue }
  $n = Split-Path $f -Leaf
  $size = (Get-Item $f).Length
  # Always replace an existing asset with the same name. Gitea happily keeps SEVERAL assets
  # with the same name, and the download URL resolves to the FIRST one -- so a stale upload
  # silently wins (that is how a "fixed" package kept serving the old bytes; the client-side
  # sha256 check is what caught it).
  # NOTE: the delete path needs BOTH ids: /releases/{release_id}/assets/{asset_id}.
  foreach ($a in @($rel.assets | Where-Object { $_.name -eq $n })) {
    Invoke-RestMethod -Uri "$api/releases/$($rel.id)/assets/$($a.id)" -Method Delete -Headers $hdr -TimeoutSec 60 | Out-Null
    Write-Host "  deleted old asset $n (id $($a.id), $([math]::Round($a.size/1MB,1)) MB)"
  }
  # curl.exe, not Invoke-RestMethod -Form: -Form is PowerShell 6+, and this shell is 5.1
  # (that is also why an earlier run "uploaded" 0-byte attachments and still printed success).
  $u = "$api/releases/$($rel.id)/assets?name=$n"
  $out = & curl.exe -s -S -u "$user`:$pass" -F "attachment=@$f" $u 2>&1
  $resp = $null
  try { $resp = $out | ConvertFrom-Json } catch { }
  if (-not $resp -or -not $resp.size) {
    throw "asset upload failed for $n :: $out"
  }
  Write-Host ("  {0} uploaded ({1:N1} MB)" -f $n, ($resp.size / 1MB))

  # Prove the public download URL serves exactly these bytes (catches leftovers, caches,
  # and "same name, two assets" surprises). This is the check that matters for clients.
  $tmp = Join-Path $env:TEMP "_verify_$n"
  Invoke-WebRequest -Uri "$repoBase/releases/download/$tag/$n" -OutFile $tmp -TimeoutSec 1800 -UseBasicParsing
  $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  $want = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ($got -ne $want) { throw "published $n does not match the built file (got $($got.Substring(0,12)), want $($want.Substring(0,12)))" }
  Write-Host "  verified: download URL returns the exact bytes we built"
  $rel = Invoke-RestMethod -Uri "$api/releases/tags/$tag" -Headers $hdr -TimeoutSec 20
}

# 6c. verify the download URLs actually work
Step 'Verifying published artifacts'
foreach ($u in @($man.app_zip.url, $man.setup.url)) {
  if (-not $u) { continue }
  try {
    $h = Invoke-WebRequest -Uri $u -Method Head -TimeoutSec 30 -UseBasicParsing
    Write-Host ("  OK   HTTP {0}  {1}" -f $h.StatusCode, $u)
  } catch { Write-Host ("  FAIL {0}  {1}" -f $_.Exception.Message, $u) -ForegroundColor Red }
}
$h2 = Invoke-WebRequest -Uri "$repoBase/raw/branch/master/release/version-v2.json" -TimeoutSec 20 -UseBasicParsing
$vRemote = ($h2.Content | ConvertFrom-Json).version
if ($vRemote -ne $ver) { throw "published manifest says V$vRemote, expected V$ver" }
Write-Host ("  manifest reachable: V{0} (v2 channel)" -f $vRemote)
Write-Host "`nClients will now see V$ver in the designer" -ForegroundColor Green
