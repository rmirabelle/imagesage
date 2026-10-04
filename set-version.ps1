<#
.SYNOPSIS
  Set the ImageSage version everywhere it is declared.

.EXAMPLE
  .\set-version.ps1 0.2.0
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
  [string] $Version
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Invoke-Native {
  <#
  .SYNOPSIS
    Run a native command (git, gh, npm, cargo) safely under Windows PowerShell 5.1.

  .DESCRIPTION
    Windows PowerShell 5.1 converts a native command's stderr output into
    NativeCommandError records whenever stderr is redirected or the host is not
    a console. With $ErrorActionPreference = "Stop" the first such line aborts
    the script even though the command succeeded (cargo prints "Compiling" to
    stderr; gh prints "release not found" to stderr). This wrapper runs the
    command with the preference set to Continue, restores it afterwards, and
    fails on the exit code instead, which is the only reliable signal.
    Standard output flows through unchanged, so results can be captured.
  #>
  param(
    [Parameter(Mandatory = $true, Position = 0)] [scriptblock] $Command,
    [string] $FailureMessage,
    [switch] $AllowFailure
  )
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = 0
  try { & $Command }
  finally { $ErrorActionPreference = $previousPreference }
  if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
    if (-not $FailureMessage) { $FailureMessage = "Command failed with exit code ${LASTEXITCODE}: $Command" }
    throw $FailureMessage
  }
}

Write-Host "==> Setting ImageSage version to $Version ..." -ForegroundColor Cyan
Invoke-Native -FailureMessage "npm version failed" { npm version $Version --no-git-tag-version --allow-same-version }

$cargoPath = "src-tauri/Cargo.toml"
$cargo = Get-Content $cargoPath -Raw
$cargo = [regex]::Replace($cargo, '(?m)^(version\s*=\s*)"[^"]+"', "`$1`"$Version`"", 1)
Set-Content -Path $cargoPath -Value $cargo -NoNewline

$tauriPath = "src-tauri/tauri.conf.json"
$tauri = Get-Content $tauriPath -Raw
$tauri = [regex]::Replace($tauri, '(?m)("version"\s*:\s*)"[^"]+"', "`$1`"$Version`"", 1)
Set-Content -Path $tauriPath -Value $tauri -NoNewline

Invoke-Native -FailureMessage "cargo check failed" { cargo check --manifest-path src-tauri/Cargo.toml }

Write-Host "==> Version synchronized. Review and commit the changed files before publishing." -ForegroundColor Green
