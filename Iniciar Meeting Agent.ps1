$startScript = Join-Path $PSScriptRoot "start.js"
Start-Process -FilePath "node.exe" -ArgumentList "`"$startScript`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
