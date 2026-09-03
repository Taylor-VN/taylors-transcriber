# Build the Windows installer for Taylor's Transcriber.
#
# Produces dist\TaylorsTranscriber-<version>-setup.exe: a per-user install
# needing no administrator rights, carrying its own Python, the base
# dependencies and ffmpeg.
#
# Requires Inno Setup 6 (iscc.exe), which is preinstalled on GitHub's
# windows-latest runners and available via `winget install JRSoftware.InnoSetup`.

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $Root

$Version = & python -c "import version; print(version.__version__)"
Write-Host "[windows] building Taylor's Transcriber $Version"

python packaging\build_payload.py --platform windows --dest build\payload
python packaging\make_icons.py --dest build\icons

# The interpreter finds its standard library relative to its own executable, so
# this copy has to live alongside python.exe rather than at the install root.
# pythonw.exe is the console-less variant; renaming it gives the running process
# a name a user can recognise in Task Manager.
Copy-Item "build\payload\python\pythonw.exe" `
          "build\payload\python\TaylorsTranscriber.exe" -Force

function Find-Iscc {
    @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}

# Inno Setup is preinstalled on GitHub's windows runners, but not on a developer
# machine and not guaranteed on future images. Install it rather than failing.
$Iscc = Find-Iscc
if (-not $Iscc) {
    Write-Host "[windows] Inno Setup not found; installing"
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install innosetup -y --no-progress
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id JRSoftware.InnoSetup --silent --accept-package-agreements --accept-source-agreements
    } else {
        throw "Inno Setup 6 not found, and neither choco nor winget is available to install it."
    }
    $Iscc = Find-Iscc
}
if (-not $Iscc) { throw "Inno Setup 6 still not found after installing." }

& $Iscc "/DAppVersion=$Version" "packaging\windows\installer.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }

$Out = "dist\TaylorsTranscriber-$Version-setup.exe"
$Size = [math]::Round((Get-Item $Out).Length / 1MB, 1)
Write-Host "[windows] $Size MB -> $Out"
