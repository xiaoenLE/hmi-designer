# sign.ps1 -- Authenticode signing for the HMI designer release artifacts.
#
# WHY THIS EXISTS
#   Switching PyInstaller -> Nuitka changes the STRUCTURE of the binary. It does not
#   change WHO published it. An unsigned exe is the single biggest reason a customer's
#   antivirus / SmartScreen flags a fresh build or silently blocks it on first run, and
#   it is the one lever that also fixes the "every rebuild is a new unknown file" problem
#   (SmartScreen reputation is tracked per certificate publisher, not per file hash).
#
#   So: the day a code-signing certificate exists, nothing else in the build has to change
#   -- both build scripts call this file and sign the shell exe AND the setup exe.
#
# USAGE (called automatically by tools\build-nuitka.ps1 and tools\build-release.ps1)
#   .\tools\sign.ps1 -Path build\release-nuitka\WebHMI-Designer-Nuitka-Setup-2.1.14.exe
#   .\tools\sign.ps1 -Path <exe> -Thumbprint 1234ABCD1234ABCD...
#   .\tools\sign.ps1 -Path <exe> -Pfx C:\certs\code.pfx -PfxPassword 'secret'
#
# CERTIFICATE LOOKUP (when neither -Thumbprint nor -Pfx is given)
#   Cert:\CurrentUser\My then Cert:\LocalMachine\My, CodeSigning EKU only, private key
#   required, not expiring within 7 days, newest NotAfter first.
#
# NO CERTIFICATE FOUND -> prints a loud warning, returns $false, exit code stays 0.
#   Deliberate: today this build box has no certificate and a missing certificate must not
#   break a build. Pass -Required in CI to turn it into a hard error instead.
#
# ASCII ONLY -- Windows PowerShell 5.1 reads a .ps1 as ANSI without a BOM (see the note in
# build-nuitka.ps1; every other script in tools\ follows the same rule).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Path,
  [string]$Thumbprint = '',
  [string]$Pfx = '',
  [string]$PfxPassword = '',
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [string]$Description = 'WebHMI Designer',
  [switch]$NoTimestamp,
  [switch]$Required
)

$ErrorActionPreference = 'Continue'

function Die([string]$msg) { throw "sign: $msg" }

# ---- 1. signtool.exe (ships with the Windows SDK, already on this box) ----
function Find-SignTool {
  $cands = @()
  $kitRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path $kitRoot) {
    $cands += Get-ChildItem $kitRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
      Where-Object { Test-Path $_ }
  }
  $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($onPath) { $cands += $onPath.Source }
  return ($cands | Select-Object -First 1)
}

# ---- 2. certificate ----
function Find-SigningCert([string]$tp) {
  $all = @()
  foreach ($store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My')) {
    $all += Get-ChildItem $store -CodeSigningCert -ErrorAction SilentlyContinue
  }
  if ($tp) {
    return ($all | Where-Object { $_.Thumbprint -eq $tp } | Select-Object -First 1)
  }
  return ($all |
    Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(7) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1)
}

$files = @()
foreach ($p in $Path) {
  $full = Resolve-Path -LiteralPath $p -ErrorAction SilentlyContinue
  if (-not $full) { Die "file not found: $p" }
  $files += $full.Path
}

$exe = Find-SignTool
if (-not $exe) {
  Write-Host '  sign: signtool.exe not found (Windows SDK missing) -- SKIPPED' -ForegroundColor Yellow
  if ($Required) { Die 'signtool.exe not found' }
  return $false
}

$cert = $null
if ($Pfx) {
  if (-not (Test-Path -LiteralPath $Pfx)) { Die "pfx not found: $Pfx" }
} else {
  $cert = Find-SigningCert $Thumbprint
  if (-not $cert) {
    Write-Host '' -ForegroundColor Yellow
    Write-Host '  ============================================================' -ForegroundColor Yellow
    Write-Host '  NOT SIGNED: no code-signing certificate on this machine.' -ForegroundColor Yellow
    Write-Host '  The package will still work, but antivirus / SmartScreen' -ForegroundColor Yellow
    Write-Host '  still see an anonymous publisher -- that is the biggest' -ForegroundColor Yellow
    Write-Host '  remaining false-positive factor. Buy a cert, import it,' -ForegroundColor Yellow
    Write-Host '  and rerun the build: this step signs automatically.' -ForegroundColor Yellow
    Write-Host '  ============================================================' -ForegroundColor Yellow
    Write-Host '' -ForegroundColor Yellow
    if ($Required) { Die 'no code-signing certificate' }
    return $false
  }
}

# ---- 3. sign + verify ----
$ok = 0
foreach ($f in $files) {
  $pargs = @('sign', '/fd', 'sha256', '/d', $Description)
  if (-not $NoTimestamp) { $pargs += @('/tr', $TimestampUrl, '/td', 'sha256') }
  if ($Pfx) {
    $pargs += @('/f', $Pfx)
    if ($PfxPassword) { $pargs += @('/p', $PfxPassword) }
  } else {
    $pargs += @('/sha1', $cert.Thumbprint)
  }
  $pargs += $f

  Write-Host ("  signing {0} ..." -f (Split-Path -Leaf $f))
  & $exe @pargs 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Die "signtool failed on $f (exit $LASTEXITCODE)" }

  $sig = Get-AuthenticodeSignature -FilePath $f
  Write-Host ("    status={0}  signer={1}" -f $sig.Status, $sig.SignerCertificate.Subject)
  if ($sig.Status -eq 'Valid') {
    $ok++
  } else {
    # A self-signed certificate is NOT chained to a trusted root, so "NotTrusted" here is
    # expected only when someone tests the pipeline with a throwaway cert. Anything that
    # ships to a customer must come out Valid.
    Write-Host ("    WARN: signature is {0} -- do NOT ship this to a customer" -f $sig.Status) -ForegroundColor Yellow
  }
}

if ($ok -ne $files.Count) {
  Write-Host ("  sign: {0} of {1} file(s) fully valid" -f $ok, $files.Count) -ForegroundColor Yellow
} else {
  Write-Host ("  sign: {0} file(s) signed and valid" -f $ok) -ForegroundColor Green
}
return ($ok -eq $files.Count)
