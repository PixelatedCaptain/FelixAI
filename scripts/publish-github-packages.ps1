param(
  [Parameter(Mandatory = $false)]
  [string]$Owner = $env:FELIXAI_GITHUB_PACKAGES_OWNER,

  [Parameter(Mandatory = $false)]
  [string]$Token = $env:FELIXAI_GITHUB_PACKAGES_TOKEN,

  [Parameter(Mandatory = $false)]
  [string]$PackagePath,

  [switch]$SkipPack
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$publishScript = Join-Path $scriptDir "publish-private-nuget.ps1"

if ([string]::IsNullOrWhiteSpace($Owner)) {
  throw "GitHub Packages owner is required. Pass -Owner or set FELIXAI_GITHUB_PACKAGES_OWNER."
}

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "GitHub Packages token is required. Pass -Token or set FELIXAI_GITHUB_PACKAGES_TOKEN."
}

$feedUrl = "https://nuget.pkg.github.com/$Owner/index.json"
$args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $publishScript, "-FeedUrl", $feedUrl, "-ApiKey", $Token)

if (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
  $args += @("-PackagePath", $PackagePath)
}

if ($SkipPack.IsPresent) {
  $args += "-SkipPack"
}

Write-Host "[felixai] publishing FelixAI.Tool to GitHub Packages owner '$Owner'"
Write-Host "[felixai] feed: $feedUrl"
& powershell @args

if ($LASTEXITCODE -ne 0) {
  throw "GitHub Packages publish failed."
}

Write-Host "[felixai] publish completed"
