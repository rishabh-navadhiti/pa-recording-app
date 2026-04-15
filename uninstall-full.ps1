# AI Medical Scribe - Full Uninstaller
# Run in an elevated (Administrator) PowerShell terminal:
#   irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/uninstall-full.ps1 | iex

Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

# ── Constants ─────────────────────────────────────────────────────────────────
$installDir   = "$env:LOCALAPPDATA\Programs\AI Medical Scribe"
$taskName     = "AI Medical Scribe"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Medical Scribe"
$startMenuLnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\AI Medical Scribe.lnk"
$notesDir     = "$env:USERPROFILE\Documents\AI Medical Notes"

$pythonPackages = @(
    "pyaudiowpatch",
    "sounddevice",
    "soundfile",
    "pydub",
    "elevenlabs",
    "requests",
    "python-dotenv",
    "numpy",
    "python-docx"
)

$wingetPackages = [ordered]@{
    "Python 3.12"            = "Python.Python.3.12"
    "Node.js LTS"            = "OpenJS.NodeJS.LTS"
    "ffmpeg"                 = "Gyan.FFmpeg"
}

$totalSteps = 7

function Step($n, $msg) {
    Write-Host ""
    Write-Host "[$n/$totalSteps] $msg" -ForegroundColor Yellow
}
function OK($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function SKIP($msg) { Write-Host "  --  $msg (not found / already removed)" -ForegroundColor Gray }
function WARN($msg) { Write-Host "  !!  $msg" -ForegroundColor Red }

# ── Elevation check ───────────────────────────────────────────────────────────
if (-not ([Security.Principal.WindowsPrincipal]
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    WARN "This script must be run as Administrator."
    Write-Host "     Right-click PowerShell and choose 'Run as administrator'." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  AI Medical Scribe  -  Uninstaller        " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Install directory : $installDir"
Write-Host ""
$confirm = Read-Host "This will remove the app and all its data. Continue? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Host "Aborted." -ForegroundColor Gray
    exit 0
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 1 — Stop the running application
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 1 "Stopping AI Medical Scribe processes..."

Get-Process -Name "electron" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.MainModule.FileName -like "*AI Medical Scribe*" } catch { $false }
} | ForEach-Object {
    $_.Kill()
    Write-Host "  Killed electron PID $($_.Id)" -ForegroundColor Gray
}

Get-Process -Name "node","npm","wscript" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.MainModule.FileName -like "*AI Medical Scribe*" } catch { $false }
} | ForEach-Object {
    $_.Kill()
    Write-Host "  Killed $($_.ProcessName) PID $($_.Id)" -ForegroundColor Gray
}

Start-Sleep -Seconds 2
OK "Processes stopped"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 2 — Remove Scheduled Task
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 2 "Removing scheduled task '$taskName'..."

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    OK "Scheduled task removed"
} else {
    SKIP "Scheduled task"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 3 — Remove Start Menu shortcut and registry entry
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 3 "Removing Start Menu shortcut and Settings > Apps entry..."

if (Test-Path $startMenuLnk) {
    Remove-Item -Path $startMenuLnk -Force
    OK "Start Menu shortcut removed"
} else {
    SKIP "Start Menu shortcut"
}

if (Test-Path $uninstallKey) {
    Remove-Item -Path $uninstallKey -Recurse -Force
    OK "Registry / Settings > Apps entry removed"
} else {
    SKIP "Registry entry"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 4 — Uninstall Python packages
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 4 "Uninstalling Python packages..."

if ($null -ne (Get-Command "python" -ErrorAction SilentlyContinue)) {
    python -m pip uninstall -y $pythonPackages 2>&1 | ForEach-Object {
        Write-Host "    $_" -ForegroundColor Gray
    }
    OK "Python packages removed"
} else {
    SKIP "Python not found — skipping package removal"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 5 — Uninstall system dependencies via winget
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 5 "Uninstalling system dependencies (Python, Node.js, ffmpeg, VC++ Build Tools)..."

if ($null -eq (Get-Command "winget" -ErrorAction SilentlyContinue)) {
    WARN "winget not found — skipping. Remove packages manually if needed."
} else {
    foreach ($entry in $wingetPackages.GetEnumerator()) {
        $label = $entry.Key
        $id    = $entry.Value
        Write-Host "  Removing $label..." -ForegroundColor Gray
        $result = winget uninstall --id $id --silent --accept-source-agreements 2>&1
        if ($LASTEXITCODE -eq 0) {
            OK "$label removed"
        } else {
            WARN "$label could not be removed (may already be uninstalled or ID changed)"
            Write-Host "  winget output: $result" -ForegroundColor Gray
        }
    }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 6 — Remove AI Medical Notes documents (ask user)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 6 "AI Medical Notes documents..."

$removeNotes = Read-Host "  Remove saved SOAP notes from '$notesDir'? (y/N)"
if ($removeNotes -eq "y" -or $removeNotes -eq "Y") {
    if (Test-Path $notesDir) {
        Remove-Item -Recurse -Force $notesDir
        OK "Documents removed"
    } else {
        SKIP "Documents folder not found — nothing to remove"
    }
} else {
    Write-Host "  -- Documents kept." -ForegroundColor Gray
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 7 — Remove install directory
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 7 "Removing app install directory..."

if (Test-Path $installDir) {
    try {
        Remove-Item -Recurse -Force $installDir
        OK "Install directory removed: $installDir"
    } catch {
        WARN "Could not remove directory immediately — scheduling deferred removal."
        $escaped = $installDir -replace "'", "''"
        Start-Process powershell.exe `
            -ArgumentList "-NoProfile -NonInteractive -Command `"Start-Sleep 3; Remove-Item -Recurse -Force '$escaped'`"" `
            -WindowStyle Hidden
    }
} else {
    SKIP "Install directory not found"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Done
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Uninstall complete.                      " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "You may close this window." -ForegroundColor Gray
Write-Host ""
