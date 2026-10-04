<#
.SYNOPSIS
  Build and publish a versioned ImageSage release to GitHub.

.DESCRIPTION
  Validates the synchronized version and clean Git state, builds the NSIS
  installer, pushes the current commit and version tag, then creates a public
  GitHub release containing the installer consumed by ImageSage's updater.
  After the new release is confirmed live, all older releases and their tags
  are deleted; ImageSage intentionally retains only the current binary release.

  Run .\set-version.ps1 VERSION and commit those changes before this script.
#>
[CmdletBinding()]
param()

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

function Read-Version {
  param([string] $Path, [string] $Pattern)
  $match = [regex]::Match((Get-Content $Path -Raw), $Pattern)
  if (-not $match.Success) { throw "Could not read version from $Path" }
  return $match.Groups[1].Value
}

function Assert-FileContains {
  param([string] $Path, [string[]] $Needles)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required release file is missing: $Path"
  }
  $contents = Get-Content -LiteralPath $Path -Raw
  foreach ($needle in $Needles) {
    if (-not $contents.Contains($needle)) {
      throw "Release invariant missing from ${Path}: $needle"
    }
  }
}

function Get-PeSubsystem {
  param([string] $Path)
  $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $Path))
  $reader = $null
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset + 24 + 68
    return $reader.ReadUInt16()
  }
  finally {
    if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
  }
}

$tauriConfig = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$nsisConfig = $tauriConfig.bundle.windows.nsis
if ($nsisConfig.template -ne "installer.nsi") {
  throw "ImageSage must use the shared XSage installer template: src-tauri/installer.nsi."
}
if (
  $nsisConfig.PSObject.Properties.Name -contains "installMode" -and
  $nsisConfig.installMode -ne "currentUser"
) {
  throw "ImageSage intentionally installs per-user. NSIS installMode must remain currentUser (or omitted)."
}
if (@($tauriConfig.bundle.resources) -notcontains "icons/icon.ico") {
  throw "The Windows icon must be bundled as a resource so installed shortcuts have a stable icon."
}
if (@($tauriConfig.bundle.targets) -notcontains "nsis") {
  throw "The release bundle targets must include NSIS."
}
if (-not (Test-Path -LiteralPath "src-tauri/icons/icon.ico" -PathType Leaf)) {
  throw "The Windows icon is missing: src-tauri/icons/icon.ico"
}

Assert-FileContains "src-tauri/src/main.rs" @(
  'windows_subsystem = "windows"'
)
Assert-FileContains "src-tauri/installer.nsi" @(
  'CopyFiles /SILENT "$INSTDIR\icons\icon.ico" "C:\Users\Public\${PRODUCTNAME}\icon.ico"',
  'Function CreateOrUpdateStartMenuShortcut',
  'Function CreateOrUpdateDesktopShortcut',
  'SetLnkAppUserModelId'
)

$cargoVersion = Read-Version "src-tauri/Cargo.toml" '(?m)^version\s*=\s*"([^"]+)"'
$packageVersion = Read-Version "package.json" '(?m)"version"\s*:\s*"([^"]+)"'
$tauriVersion = Read-Version "src-tauri/tauri.conf.json" '(?m)"version"\s*:\s*"([^"]+)"'
if ($cargoVersion -ne $packageVersion -or $cargoVersion -ne $tauriVersion) {
  throw "Version mismatch: Cargo=$cargoVersion, package=$packageVersion, Tauri=$tauriVersion. Run .\set-version.ps1 VERSION."
}

$version = $cargoVersion
$tag = "v$version"
$assetName = "ImageSage_${version}_x64-setup.exe"
$assetPath = "dist/$assetName"

Invoke-Native -FailureMessage "ImageSage is not a Git repository." { git rev-parse --is-inside-work-tree *> $null }
$dirtyFiles = Invoke-Native -FailureMessage "Could not read the Git working tree status." { git status --porcelain }
if ($dirtyFiles) { throw "The working tree must be clean before publishing." }

$origin = Invoke-Native -AllowFailure { git remote get-url origin }
if ($LASTEXITCODE -ne 0 -or $origin -notmatch 'github\.com[/:]rmirabelle/imagesage(?:\.git)?$') {
  throw "The origin remote must be the public rmirabelle/imagesage GitHub repository."
}

Invoke-Native -FailureMessage "GitHub CLI is not authenticated. Run: gh auth login -h github.com" { gh auth status *> $null }

Invoke-Native -AllowFailure { gh release view $tag *> $null }
if ($LASTEXITCODE -eq 0) { throw "Release $tag already exists." }

Write-Host "==> Building ImageSage $tag ..." -ForegroundColor Cyan
Invoke-Native -FailureMessage "Tauri build failed" { npm run tauri build }

$releaseExe = "src-tauri/target/release/imagesage.exe"
if ((Get-PeSubsystem $releaseExe) -ne 2) {
  throw "The release executable is not a Windows GUI-subsystem application; it would open a console window."
}

$generatedNsis = "src-tauri/target/release/nsis/x64/installer.nsi"
Assert-FileContains $generatedNsis @(
  '!define INSTALLMODE "currentUser"',
  '/oname=icons\icon.ico',
  'CopyFiles /SILENT "$INSTDIR\icons\icon.ico" "C:\Users\Public\${PRODUCTNAME}\icon.ico"',
  'CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"',
  'CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk"',
  'SetLnkAppUserModelId'
)

$bundleDir = "src-tauri/target/release/bundle/nsis"
$installer = Get-ChildItem $bundleDir -Filter "*_${version}_x64-setup.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $installer) { throw "Expected NSIS installer not found in $bundleDir for version $version" }
if ($installer.Length -le 0) { throw "The generated NSIS installer is empty: $($installer.FullName)" }
New-Item -ItemType Directory -Force -Path "dist" | Out-Null
Copy-Item $installer.FullName $assetPath -Force

Write-Host "==> Pushing source and tag $tag ..." -ForegroundColor Cyan
Invoke-Native -FailureMessage "Could not push the release commit" { git push origin HEAD }
Invoke-Native -FailureMessage "Could not create tag $tag" { git tag -a $tag -m "ImageSage $tag" }
Invoke-Native -FailureMessage "Could not push tag $tag" { git push origin $tag }

Write-Host "==> Publishing GitHub release $tag ..." -ForegroundColor Cyan
Invoke-Native -FailureMessage "Could not create GitHub release $tag" { gh release create $tag $assetPath --verify-tag --title "ImageSage $tag" --generate-notes }

$publishedReleaseJson = Invoke-Native -FailureMessage "Could not verify GitHub release $tag" { gh release view $tag --json tagName,isDraft,isPrerelease,assets }
$publishedRelease = $publishedReleaseJson | ConvertFrom-Json
$publishedAssets = @($publishedRelease.assets | ForEach-Object { $_.name })
if (
  $publishedRelease.tagName -ne $tag -or
  $publishedRelease.isDraft -or
  $publishedRelease.isPrerelease -or
  $publishedAssets -notcontains $assetName
) {
  throw "GitHub release $tag did not pass post-publish verification. Older releases were preserved."
}

$latestReleaseJson = Invoke-Native -FailureMessage "Could not verify the latest-release endpoint. Older releases were preserved." { gh api repos/rmirabelle/imagesage/releases/latest }
$latestRelease = $latestReleaseJson | ConvertFrom-Json
$latestAssets = @($latestRelease.assets | ForEach-Object { $_.name })
if ($latestRelease.tag_name -ne $tag -or $latestAssets -notcontains $assetName) {
  throw "GitHub's releases/latest endpoint does not resolve to the newly published ImageSage installer. Older releases were preserved."
}

Write-Host "==> Removing superseded releases ..." -ForegroundColor Cyan
$priorReleases = @(Invoke-Native -FailureMessage "Could not list existing GitHub releases" { gh release list --limit 100 --json tagName -q '.[].tagName' })
foreach ($priorTag in $priorReleases) {
  if ($priorTag -and $priorTag -ne $tag) {
    Write-Host "    - deleting $priorTag"
    Invoke-Native -FailureMessage "Could not delete superseded release $priorTag" { gh release delete $priorTag --yes --cleanup-tag }
  }
}

Write-Host "==> Published https://github.com/rmirabelle/imagesage/releases/tag/$tag" -ForegroundColor Green
