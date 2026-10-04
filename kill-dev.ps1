<#
.SYNOPSIS
  Stop the ImageSage dev app: tree-kill imagesage.exe and free the Vite port.
#>
$ErrorActionPreference = "Continue"

Get-Process -Name imagesage -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "Stopping imagesage.exe (PID $($_.Id))"
  & taskkill.exe /PID $_.Id /T /F | Out-Null
}

foreach ($port in 14410, 14411) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      Write-Host "Stopping PID $_ (port $port)"
      & taskkill.exe /PID $_ /T /F | Out-Null
    }
}
