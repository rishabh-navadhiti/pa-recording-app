# AI Medical Scribe - Uninstaller
# Registered automatically by install.ps1 and appears in Settings > Apps.
# Can also be run directly from the install directory.

Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

$installDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName    = "AI Medical Scribe"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Medical Scribe"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  AI Medical Scribe  -  Uninstaller        " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ---- Stop running app -------------------------------------------------------
Write-Host "Stopping app..." -ForegroundColor Yellow
# Target only the AI Medical Scribe electron process by matching its working
# directory (install path), not by process name — which would kill VS Code
# and any other Electron-based app running on the machine.
Get-Process -Name "electron" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.MainModule.FileName -like "*$installDir*" } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue
# Also kill any npm/node process that launched from the install directory
Get-Process -Name "node","npm" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.MainModule.FileName -like "*$installDir*" } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ---- Remove Task Scheduler task ---------------------------------------------
Write-Host "Removing autostart task..." -ForegroundColor Yellow
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# ---- Remove Start Menu shortcut ---------------------------------------------
Write-Host "Removing Start Menu shortcut..." -ForegroundColor Yellow
$startMenuLnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\AI Medical Scribe.lnk"
Remove-Item -Path $startMenuLnk -Force -ErrorAction SilentlyContinue

# ---- Remove registry uninstall entry ----------------------------------------
Write-Host "Removing from Settings > Apps..." -ForegroundColor Yellow
Remove-Item -Path $uninstallKey -Force -ErrorAction SilentlyContinue

# ---- Optionally remove documents --------------------------------------------
Write-Host ""
$removeNotes = Read-Host "Remove AI Medical Notes documents from Documents folder? (y/N)"
if ($removeNotes -eq "y" -or $removeNotes -eq "Y") {
    $notesDir = "$env:USERPROFILE\Documents\AI Medical Notes"
    if (Test-Path $notesDir) {
        Remove-Item -Recurse -Force $notesDir -ErrorAction SilentlyContinue
        Write-Host "Documents removed." -ForegroundColor Green
    } else {
        Write-Host "Documents folder not found - skipping." -ForegroundColor Gray
    }
}

# ---- Clear electron cache ---------------------------------------------------
# Remove cached electron zips so a future reinstall always downloads a fresh
# copy — avoids the silent extract-zip failure on locked dist/locales/ folder.
Write-Host "Clearing electron cache..." -ForegroundColor Yellow
$electronCache = "$env:LOCALAPPDATA\electron\Cache"
if (Test-Path $electronCache) {
    Get-ChildItem $electronCache -Recurse -Filter "electron-*-win32-x64.zip" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

# ---- Remove install directory (deferred - this script lives inside it) ------
Write-Host ""
Write-Host "Removing app files..." -ForegroundColor Yellow
$escapedDir = $installDir -replace "'", "''"
$deferred = "Start-Sleep -Seconds 2; Remove-Item -Recurse -Force '$escapedDir' -ErrorAction SilentlyContinue"
Start-Process powershell.exe -ArgumentList "-NoProfile -NonInteractive -Command `"$deferred`"" -WindowStyle Hidden

Write-Host ""
Write-Host "AI Medical Scribe has been uninstalled." -ForegroundColor Cyan
Write-Host ""
