# AI Medical Scribe - Reinstaller (steps 7-11)
# Skips dependency installs (Git, Python, Node.js, ffmpeg, VC++ Build Tools, Claude CLI).
# Assumes those are already installed. Clones/updates the repo, installs packages,
# and re-registers Task Scheduler, Start Menu shortcut, and Settings > Apps.
#
#   irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/reinstall.ps1 | iex

Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$REPO_URL  = "https://github.com/rishabh-navadhiti/pa-recording-app.git"
$taskName  = "AI Medical Scribe"
$totalSteps = 5

# When run via irm | iex, $MyInvocation.MyCommand.Path is empty — fall back to
# the default install location used by install.ps1.
$scriptPath = $MyInvocation.MyCommand.Path
if ($scriptPath) {
    $installDir = Split-Path -Parent $scriptPath
} else {
    $installDir = "$env:LOCALAPPDATA\Programs\AI Medical Scribe"
}

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

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  AI Medical Scribe  -  Reinstaller        " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# ---- 1 (step 7). Clone / update repo ----------------------------------------
Step 1 "Cloning repository to $installDir..."
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

# ---- 2 (step 8). Python packages --------------------------------------------
Step 2 "Installing Python packages..."
Refresh-Path
# Prefer the `py` launcher (matches what the app uses at runtime). Fall back to
# `python` if `py` is unavailable, then the versioned path as a last resort.
$pyLauncher = (Get-Command py -ErrorAction SilentlyContinue).Source
if ($pyLauncher) {
    $pythonExe = "py"
} else {
    $pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $pythonExe -or $pythonExe -like "*WindowsApps*") {
        # Last resort: try common versioned install paths
        foreach ($p in @("C:\Program Files\Python313\python.exe", "C:\Program Files\Python312\python.exe")) {
            if (Test-Path $p) { $pythonExe = $p; break }
        }
    }
}
Write-Host "  Using Python: $pythonExe" -ForegroundColor Gray
Push-Location $installDir
& $pythonExe -m pip install --upgrade pip --quiet
& $pythonExe -m pip install -r requirements.txt --quiet
Pop-Location
OK "Python packages OK"

# ---- 3 (step 9). Node packages ----------------------------------------------
Step 3 "Installing Node packages..."
Refresh-Path
Push-Location $installDir
npm install --silent
# Rebuild better-sqlite3 for the bundled Electron runtime (native addon — the
# npm install above builds it for system Node.js, which has a different ABI).
Write-Host "  Rebuilding native modules for Electron..." -ForegroundColor Gray
npx electron-rebuild -f -w better-sqlite3
Pop-Location
OK "Node packages OK"

# ---- 4 (step 10). Config file -----------------------------------------------
Step 4 "Creating config file..."
$envFile = Join-Path $installDir ".env"
if (-not (Test-Path $envFile)) {
    "ELEVENLABS_API_KEY=" | Set-Content $envFile -Encoding UTF8
}
OK "Config file ready - add your ElevenLabs key in the app after launch"

# ---- 5 (step 11). Autostart via Task Scheduler ------------------------------
Step 5 "Registering autostart (Task Scheduler)..."
# Resolve electron binary via path.txt (the npm package's canonical pointer).
$electronPathTxt = Join-Path $installDir "node_modules\electron\path.txt"
if (Test-Path $electronPathTxt) {
    $electronRelative = (Get-Content $electronPathTxt -Raw).Trim()
    $electronExe = Join-Path $installDir "node_modules\electron\$electronRelative"
} else {
    $electronExe = Join-Path $installDir "node_modules\electron\dist\electron.exe"
}
if (-not (Test-Path $electronExe)) {
    Write-Host "  ERROR: Electron binary not found at: $electronExe" -ForegroundColor Red
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

# ---- Start Menu shortcut ----------------------------------------------------
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

# ---- Registry: Settings > Apps ----------------------------------------------
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

# ---- Optionally recreate documents folder -----------------------------------
Write-Host ""
$notesDir    = "$env:USERPROFILE\Documents\AI Medical Notes"
$createNotes = Read-Host "Recreate AI Medical Notes documents folder? (y/N)"
if ($createNotes -eq "y" -or $createNotes -eq "Y") {
    if (Test-Path $notesDir) {
        Write-Host "  Documents folder already exists - skipping." -ForegroundColor Gray
    } else {
        New-Item -ItemType Directory -Path $notesDir -Force | Out-Null
        Write-Host "  Documents folder created at: $notesDir" -ForegroundColor Green
    }
}

# ---- Done -------------------------------------------------------------------
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Reinstall complete!                      " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Launching AI Medical Scribe..." -ForegroundColor Cyan
Start-Process $electronExe -ArgumentList "." -WorkingDirectory $installDir
