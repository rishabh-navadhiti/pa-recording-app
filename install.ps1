# AI Medical Scribe - Windows Installer (Option A)
# Run in an elevated PowerShell terminal:
#   irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/install.ps1 | iex

# Allow this process (and child processes like npm.ps1) to run scripts
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

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
# Windows App Execution Aliases intercept the bare 'python' command even after
# a real Python is installed. Locate the real interpreter directly to avoid the
# Microsoft Store redirect stub.
$pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $pythonExe -or $pythonExe -like "*WindowsApps*") {
    $pythonExe = "C:\Program Files\Python312\python.exe"
}
if (-not (Test-Path $pythonExe)) {
    Write-Host "  WARNING: Python not found at expected path — PATH may need a restart" -ForegroundColor Yellow
} else {
    OK "Python $( & $pythonExe --version 2>&1 )"
    # Override $env:Path so subsequent script steps use the real python
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
    # Claude CLI installs to $env:USERPROFILE\.local\bin — ensure it is on PATH
    $claudeBin = "$env:USERPROFILE\.local\bin"
    Add-ToUserPath $claudeBin
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
    if (Test-Path $installDir) {
        Write-Host "  Removing incomplete previous install..." -ForegroundColor Gray
        Remove-Item -Path $installDir -Recurse -Force
    }
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
Step 11 "Registering autostart (Task Scheduler)..."

# Launch Electron directly — it's a GUI app so no console window appears.
# This avoids wscript.exe + VBS which triggers antivirus false positives
# (Bitdefender, ESET, PC Matic flag VBS as a malware vector).
$electronExe = Join-Path $installDir "node_modules\electron\dist\electron.exe"

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
$shortcut  = $WshShell.CreateShortcut("$startMenuPath\AI Medical Scribe.lnk")
$shortcut.TargetPath       = $electronExe
$shortcut.Arguments        = "."
$shortcut.WorkingDirectory = $installDir
$shortcut.Description      = "AI Medical Scribe — audio capture and SOAP note generator"
$shortcut.Save()
OK "Start Menu shortcut created"

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
Start-Process $electronExe -ArgumentList "." -WorkingDirectory $installDir
