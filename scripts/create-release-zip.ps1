$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$packageJsonPath = Join-Path $projectRoot "package.json"
$package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$version = $package.version

$distPath = Join-Path $projectRoot "dist"
if (-not (Test-Path $distPath)) {
  throw "Missing dist output. Run 'npm run build' first."
}

$releaseRoot = Join-Path $projectRoot "tmp\release"
$stagingPath = Join-Path $releaseRoot "felixai-$version-windows"
$zipPath = Join-Path $releaseRoot "felixai-$version-windows.zip"

if (Test-Path $stagingPath) {
  Remove-Item -LiteralPath $stagingPath -Recurse -Force
}

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
Copy-Item -LiteralPath $distPath -Destination (Join-Path $stagingPath "dist") -Recurse -Force

foreach ($fileName in @("README.md", "package.json")) {
  $sourcePath = Join-Path $projectRoot $fileName
  if (Test-Path $sourcePath) {
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $stagingPath $fileName) -Force
  }
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Compress-Archive -Path (Join-Path $stagingPath "*") -DestinationPath $zipPath -Force

Write-Output $zipPath
