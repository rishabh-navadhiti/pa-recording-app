# AI Medical Scribe - Windows Setup Script
# Run in PowerShell as Administrator:
#   Right-click PowerShell -> "Run as administrator"
#   cd to the repo folder, then: .\setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
}

Write-Host ""
Write-Host "=== AI Medical Scribe Setup ===" -ForegroundColor Cyan

# 1. Python
Write-Host ""
Write-Host "[1/5] Installing Python 3.12..." -ForegroundColor Yellow
winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements --override "/quiet InstallAllUsers=1 PrependPath=1 Include_pip=1"
Refresh-Path
python --version
Write-Host "Python OK" -ForegroundColor Green

# 2. Node.js
Write-Host ""
Write-Host "[2/5] Installing Node.js LTS..." -ForegroundColor Yellow
winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
Refresh-Path
node --version
npm --version
Write-Host "Node.js OK" -ForegroundColor Green

# 3. ffmpeg
Write-Host ""
Write-Host "[3/5] Installing ffmpeg..." -ForegroundColor Yellow
winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements
Refresh-Path
ffmpeg -version 2>&1 | Select-Object -First 1
Write-Host "ffmpeg OK" -ForegroundColor Green

# 4. Visual C++ Build Tools (needed for pyaudiowpatch)
Write-Host ""
Write-Host "[4/5] Installing Visual C++ Build Tools..." -ForegroundColor Yellow
Write-Host "      (large download ~4GB, may take several minutes)"
winget install Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements --accept-source-agreements --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait"
Write-Host "Visual C++ Build Tools OK" -ForegroundColor Green

# 5. Python packages
Write-Host ""
Write-Host "[5/5] Installing Python packages..." -ForegroundColor Yellow
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Write-Host "Python packages OK" -ForegroundColor Green

# 6. Node packages
Write-Host ""
Write-Host "Installing Node packages..." -ForegroundColor Yellow
npm install
Write-Host "Node packages OK" -ForegroundColor Green

# 7. Create .env if missing
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host ""
    Write-Host ".env created from .env.example" -ForegroundColor Yellow
    Write-Host "IMPORTANT: Open .env and add your ElevenLabs API key before running the app." -ForegroundColor Red
} else {
    Write-Host ""
    Write-Host ".env already exists - skipping" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open .env and set your ELEVENLABS_API_KEY"
Write-Host "  2. Run: npm start"
Write-Host ""
