# Abre o Meeting Agent pelo inicializador que higieniza o ambiente do Electron.
$startScript = Join-Path $PSScriptRoot "start.js"
Start-Process -FilePath "node.exe" -ArgumentList "`"$startScript`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
