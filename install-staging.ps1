# AI Medical Scribe - Windows Installer (STAGING build)
#
# This script installs a separate "staging" copy of the app, cloned from the
# `staging` branch instead of `main`. It exists so developers can test the
# auto-update + skill-sync pipeline in a real installed app before changes
# reach end users.
#
# Run in an elevated PowerShell terminal:
#   irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/install-staging.ps1 | iex
#
# Side-by-side with prod:
#   - Install dir:   %LOCALAPPDATA%\Programs\AI Medical Scribe (Staging)
#   - Scheduled task: "AI Medical Scribe (Staging)"
#   - Start Menu:    "AI Medical Scribe (Staging).lnk"
#   - A local-only .staging-marker file is written into the install dir.
#     Its presence flips the app into staging mode (UI badge, tooltip suffix).
#     The marker is gitignored so it never leaks back to the repo.
#
# Note: Electron's single-instance lock is shared by appName, so you cannot
# run prod + staging at the same time. Quit one before launching the other.

Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$REPO_URL   = "https://github.com/rishabh-navadhiti/pa-recording-app.git"
$BRANCH     = "staging"
$installDir = "$env:LOCALAPPDATA\Programs\AI Medical Scribe (Staging)"
$taskName   = "AI Medical Scribe (Staging)"
$totalSteps = 11

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Add-ToUserPath($dir) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($current -notlike "*$dir*") {
        [Environment]::SetEnvironmentVariable("Path", "$current;$dir", "User")
        $env:Path = "$env:Path;$dir"
    }
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
Write-Host "============================================" -ForegroundColor Magenta
Write-Host "  AI Medical Scribe  -  STAGING Installer  " -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta
Write-Host "  Branch: $BRANCH" -ForegroundColor Magenta

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
$pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $pythonExe -or $pythonExe -like "*WindowsApps*") {
    $pythonExe = "C:\Program Files\Python312\python.exe"
}
if (-not (Test-Path $pythonExe)) {
    Write-Host "  WARNING: Python not found at expected path — PATH may need a restart" -ForegroundColor Yellow
} else {
    OK "Python $( & $pythonExe --version 2>&1 )"
    $env:Path = (Split-Path $pythonExe) + ";" + $env:Path
}

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
    $claudeBin = "$env:USERPROFILE\.local\bin"
    Add-ToUserPath $claudeBin
    OK "Claude CLI installed"
} catch {
    Write-Host "  WARNING: Claude CLI install failed: $_" -ForegroundColor Red
    Write-Host "  Install it manually later: irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
}
Refresh-Path

# ---- 7. Clone / update repo (staging branch) --------------------------------
Step 7 "Cloning repository ($BRANCH branch) to $installDir..."
if (Test-Path (Join-Path $installDir ".git")) {
    Write-Host "  Repo already exists - fetching and switching to $BRANCH..." -ForegroundColor Gray
    Push-Location $installDir
    git fetch origin
    git checkout $BRANCH
    git pull --ff-only
    Pop-Location
} else {
    if (Test-Path $installDir) {
        Write-Host "  Removing incomplete previous install..." -ForegroundColor Gray
        Remove-Item -Path $installDir -Recurse -Force
    }
    git clone -b $BRANCH $REPO_URL $installDir
}
OK "Repository ready (branch: $BRANCH)"

# ---- 7b. Write staging marker -----------------------------------------------
# Local-only flag that the app reads at startup to flip into staging mode
# (UI badge, "(staging)" suffix on update notifications). Gitignored.
$markerPath = Join-Path $installDir ".staging-marker"
@"
This install was created by install-staging.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm').
Its presence tells the app it is a staging build. Do not commit this file.
"@ | Set-Content $markerPath -Encoding UTF8
OK "Staging marker written"

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
# Rebuild better-sqlite3 for the bundled Electron runtime (native addon — the
# npm install above builds it for system Node.js, which has a different ABI).
Write-Host "  Rebuilding native modules for Electron..." -ForegroundColor Gray
npx electron-rebuild -f -w better-sqlite3
Pop-Location
OK "Node packages OK"

# ---- 10. Create config file -------------------------------------------------
Step 10 "Creating config file..."
$envFile = Join-Path $installDir ".env"
if (-not (Test-Path $envFile)) {
    "ELEVENLABS_API_KEY=" | Set-Content $envFile -Encoding UTF8
}
OK "Config file ready - add your ElevenLabs key in the app after launch"

# ---- 11. Autostart via Task Scheduler ---------------------------------------
Step 11 "Registering autostart ($taskName)..."

$electronPathTxt = Join-Path $installDir "node_modules\electron\path.txt"
if (Test-Path $electronPathTxt) {
    $electronRelative = (Get-Content $electronPathTxt -Raw).Trim()
    $electronExe = Join-Path $installDir "node_modules\electron\$electronRelative"
} else {
    $electronExe = Join-Path $installDir "node_modules\electron\dist\electron.exe"
}
if (-not (Test-Path $electronExe)) {
    Write-Host "  ERROR: Electron binary not found at $electronExe" -ForegroundColor Red
    Write-Host "  Try running 'npm install' again in $installDir" -ForegroundColor Yellow
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute  $electronExe `
    -Argument "." `
    -WorkingDirectory $installDir

$trigger = New-ScheduledTaskTrigger -AtLogon -User "$env:USERDOMAIN\$env:USERNAME"

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

# ---- Start Menu shortcut ---------------------------------------------------
Write-Host ""
Write-Host "[extra] Creating Start Menu shortcut..." -ForegroundColor Yellow
$startMenuPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$WshShell  = New-Object -ComObject WScript.Shell
$shortcut  = $WshShell.CreateShortcut("$startMenuPath\AI Medical Scribe (Staging).lnk")
$shortcut.TargetPath       = $electronExe
$shortcut.Arguments        = "."
$shortcut.WorkingDirectory = $installDir
$shortcut.Description      = "AI Medical Scribe (Staging) — internal test build"
$shortcut.Save()
OK "Start Menu shortcut created"

# ---- Registry: add to Settings > Apps --------------------------------------
Write-Host ""
Write-Host "[extra] Registering in Settings > Apps..." -ForegroundColor Yellow
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Medical Scribe (Staging)"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName"     -Value "AI Medical Scribe (Staging)"
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion"  -Value "0.1.0-staging"
Set-ItemProperty -Path $uninstallKey -Name "Publisher"       -Value "AI Medical Scribe"
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $installDir
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" `
    -Value "powershell.exe -ExecutionPolicy Bypass -File `"$installDir\uninstall.ps1`""
Set-ItemProperty -Path $uninstallKey -Name "NoModify" -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name "NoRepair" -Value 1 -Type DWord
OK "App registered"

# ---- Launch -----------------------------------------------------------------
Write-Host ""
Write-Host "============================================" -ForegroundColor Magenta
Write-Host "  Staging install complete!                " -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "Reminder: this app auto-updates from the '$BRANCH' branch." -ForegroundColor Yellow
Write-Host "Quit the production install before launching staging — they share a single-instance lock." -ForegroundColor Yellow
Write-Host ""
Write-Host "Launching AI Medical Scribe (Staging)..." -ForegroundColor Cyan
Start-Process $electronExe -ArgumentList "." -WorkingDirectory $installDir
