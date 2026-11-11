# Meeting Agent — Overlay Electron
# Use este script no PowerShell: .\start-overlay.ps1

Set-Location "$PSScriptRoot"
$electron = ".\node_modules\electron\dist\electron.exe"
if (Test-Path $electron) {
    & $electron .
} else {
    npx electron .
}
