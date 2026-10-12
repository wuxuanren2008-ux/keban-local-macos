param([switch]$SkipInstall, [switch]$DirectoryOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    $pythonCommand = Get-Command python -ErrorAction Stop
    & $pythonCommand.Source -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required; install Python from python.org.' }
}
$pythonExe = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not $SkipInstall) {
    & $pythonExe -m pip install -r desktop/requirements.txt pyinstaller
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed' }
    node node_modules/electron/install.js
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime download failed' }
}
& $pythonExe scripts/prepare_desktop.py
if ($LASTEXITCODE -ne 0) { throw 'Web asset build failed' }
& $pythonExe -m PyInstaller --noconfirm --clean --onedir --name lecture-runtime --distpath build/runtime --workpath build/pyinstaller --specpath build --paths . --collect-all faster_whisper --collect-all ctranslate2 --collect-all av --collect-all onnxruntime --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto --hidden-import uvicorn.protocols.http.auto --hidden-import uvicorn.protocols.websockets.auto --hidden-import pypdf desktop/launcher.py
if ($LASTEXITCODE -ne 0) { throw 'Python runtime packaging failed' }
if ($DirectoryOnly) { npm.cmd run pack } else { npm.cmd run dist }
if ($LASTEXITCODE -ne 0) { throw 'Desktop packaging failed' }
Write-Output 'Build complete. See release/ for the Windows installer and portable executable.'
