# AI Medical Scribe - Windows Installer (Option A)
# Run in an elevated PowerShell terminal:
#   irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/install.ps1 | iex

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$REPO_URL   = "https://github.com/rishabh-navadhiti/pa-recording-app.git"
$installDir = "$env:LOCALAPPDATA\Programs\AI Medical Scribe"
$taskName   = "AI Medical Scribe"
$totalSteps = 11

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Step($n, $msg) {
    Write-Host ""
    Write-Host "[$n/$totalSteps] $msg" -ForegroundColor Yellow
}

function OK($msg) {
    Write-Host "  $msg" -ForegroundColor Green
}

# ---- Elevation check --------------------------------------------------------
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: Run this script in an elevated (Administrator) PowerShell." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  AI Medical Scribe  -  Windows Installer  " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# ---- 1. Git -----------------------------------------------------------------
Step 1 "Installing Git..."
winget install Git.Git --silent --accept-package-agreements --accept-source-agreements
Refresh-Path
OK "Git OK"

# ---- 2. Python 3.12 ---------------------------------------------------------
Step 2 "Installing Python 3.12..."
winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements `
    --override "/quiet InstallAllUsers=1 PrependPath=1 Include_pip=1"
Refresh-Path
OK "Python $(python --version 2>&1)"

# ---- 3. Node.js LTS ---------------------------------------------------------
Step 3 "Installing Node.js LTS..."
winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
Refresh-Path
OK "Node $(node --version)  npm $(npm --version)"

# ---- 4. ffmpeg --------------------------------------------------------------
Step 4 "Installing ffmpeg..."
winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements
Refresh-Path
OK "ffmpeg OK"

# ---- 5. Visual C++ Build Tools (needed for pyaudiowpatch) ------------------
Step 5 "Installing Visual C++ Build Tools (~4 GB, may take several minutes)..."
winget install Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements `
    --accept-source-agreements `
    --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait"
OK "Build Tools OK"

# ---- 6. Claude CLI ----------------------------------------------------------
Step 6 "Installing Claude CLI..."
try {
    irm https://claude.ai/install.ps1 | iex
    OK "Claude CLI installed"
} catch {
    Write-Host "  WARNING: Claude CLI install failed: $_" -ForegroundColor Red
    Write-Host "  Install it manually later: irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
}
Refresh-Path

# ---- 7. Clone / update repo -------------------------------------------------
Step 7 "Cloning repository to $installDir..."
if (Test-Path (Join-Path $installDir ".git")) {
    Write-Host "  Repo already exists - pulling latest..." -ForegroundColor Gray
    Push-Location $installDir
    git pull --ff-only
    Pop-Location
} else {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    git clone $REPO_URL $installDir
}
OK "Repository ready"

# ---- 8. Python packages -----------------------------------------------------
Step 8 "Installing Python packages..."
Push-Location $installDir
python -m pip install --upgrade pip --quiet
python -m pip install -r requirements.txt --quiet
Pop-Location
OK "Python packages OK"

# ---- 9. Node packages -------------------------------------------------------
Step 9 "Installing Node packages..."
Push-Location $installDir
npm install --silent
Pop-Location
OK "Node packages OK"

# ---- 10. ElevenLabs API key -------------------------------------------------
Step 10 "ElevenLabs API key..."
$envFile    = Join-Path $installDir ".env"
$existingKey = ""

if (Test-Path $envFile) {
    $keyLine = (Get-Content $envFile) | Where-Object { $_ -match "^ELEVENLABS_API_KEY=(.+)$" }
    if ($keyLine -and ($Matches[1] -ne "your_key_here") -and ($Matches[1].Trim() -ne "")) {
        $existingKey = $Matches[1].Trim()
    }
}

if ($existingKey -eq "") {
    Write-Host "  ElevenLabs API key is required for transcription." -ForegroundColor Yellow
    Write-Host "  Get yours: elevenlabs.io -> Profile -> API Keys" -ForegroundColor Cyan
    do {
        $apiKey = (Read-Host "  Enter ElevenLabs API key").Trim()
        if ($apiKey -eq "") { Write-Host "  Key cannot be empty." -ForegroundColor Red }
    } while ($apiKey -eq "")
    "ELEVENLABS_API_KEY=$apiKey" | Set-Content $envFile -Encoding UTF8
    OK "API key saved to .env"
} else {
    OK "API key already set - skipping"
}

# ---- 11. Autostart via Task Scheduler ---------------------------------------
Step 11 "Registering autostart (Task Scheduler)..."

$vbsPath = Join-Path $installDir "launch.vbs"

$action = New-ScheduledTaskAction `
    -Execute  "wscript.exe" `
    -Argument "`"$vbsPath`"" `
    -WorkingDirectory $installDir

$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit 0 `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName  $taskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -RunLevel  Limited `
    -Force | Out-Null

OK "Task '$taskName' registered"

# ---- Registry: add to Settings > Apps --------------------------------------
Write-Host ""
Write-Host "[extra] Registering in Settings > Apps..." -ForegroundColor Yellow
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Medical Scribe"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName"     -Value "AI Medical Scribe"
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion"  -Value "0.1.0"
Set-ItemProperty -Path $uninstallKey -Name "Publisher"       -Value "AI Medical Scribe"
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $installDir
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" `
    -Value "powershell.exe -ExecutionPolicy Bypass -File `"$installDir\uninstall.ps1`""
Set-ItemProperty -Path $uninstallKey -Name "NoModify" -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name "NoRepair" -Value 1 -Type DWord
OK "App registered"

# ---- Launch -----------------------------------------------------------------
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Installation complete!                   " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "IMPORTANT: Run 'claude login' once in a terminal to authenticate Claude CLI." -ForegroundColor Yellow
Write-Host ""
Write-Host "Launching AI Medical Scribe..." -ForegroundColor Cyan
Start-Process "wscript.exe" -ArgumentList "`"$vbsPath`"" -WorkingDirectory $installDir
