# AI Medical Scribe - Re-Registration Script
# Run this from the install directory, or via:
#   irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/reinstall.ps1 | iex

Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

# When run via irm | iex, $MyInvocation.MyCommand.Path is empty — fall back to
# the default install location used by install.ps1.
$scriptPath = $MyInvocation.MyCommand.Path
if ($scriptPath) {
    $installDir = Split-Path -Parent $scriptPath
} else {
    $installDir = "$env:LOCALAPPDATA\Programs\AI Medical Scribe"
}
$taskName    = "AI Medical Scribe"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Medical Scribe"
$electronExe = Join-Path $installDir "node_modules\electron\dist\electron.exe"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  AI Medical Scribe  -  Re-Registration    " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ---- Guard: app files must already be present -------------------------------
if (-not (Test-Path $electronExe)) {
    Write-Host "ERROR: Electron not found at:" -ForegroundColor Red
    Write-Host "  $electronExe" -ForegroundColor Red
    Write-Host ""
    Write-Host "Run the full installer first:" -ForegroundColor Yellow
    Write-Host "  powershell.exe -ExecutionPolicy Bypass -File install.ps1" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# ---- 1. Autostart via Task Scheduler ----------------------------------------
Write-Host "Registering autostart (Task Scheduler)..." -ForegroundColor Yellow

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

Write-Host "  Task '$taskName' registered." -ForegroundColor Green

# ---- 2. Start Menu shortcut -------------------------------------------------
Write-Host "Creating Start Menu shortcut..." -ForegroundColor Yellow

$startMenuPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$WshShell  = New-Object -ComObject WScript.Shell
$shortcut  = $WshShell.CreateShortcut("$startMenuPath\AI Medical Scribe.lnk")
$shortcut.TargetPath       = $electronExe
$shortcut.Arguments        = "."
$shortcut.WorkingDirectory = $installDir
$shortcut.Description      = "AI Medical Scribe — audio capture and SOAP note generator"
$shortcut.Save()

Write-Host "  Start Menu shortcut created." -ForegroundColor Green

# ---- 3. Registry: Settings > Apps -------------------------------------------
Write-Host "Registering in Settings > Apps..." -ForegroundColor Yellow

New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName"     -Value "AI Medical Scribe"
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion"  -Value "0.1.0"
Set-ItemProperty -Path $uninstallKey -Name "Publisher"       -Value "AI Medical Scribe"
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $installDir
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" `
    -Value "powershell.exe -ExecutionPolicy Bypass -File `"$installDir\uninstall.ps1`""
Set-ItemProperty -Path $uninstallKey -Name "NoModify" -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name "NoRepair" -Value 1 -Type DWord

Write-Host "  App registered in Settings > Apps." -ForegroundColor Green

# ---- 4. Optionally recreate documents folder --------------------------------
Write-Host ""
$notesDir = "$env:USERPROFILE\Documents\AI Medical Notes"
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
Write-Host "  Registration complete!                   " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$launch = Read-Host "Launch AI Medical Scribe now? (y/N)"
if ($launch -eq "y" -or $launch -eq "Y") {
    Start-Process $electronExe -ArgumentList "." -WorkingDirectory $installDir
}
