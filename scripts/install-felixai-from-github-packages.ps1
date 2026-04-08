param(
  [Parameter(Mandatory = $false)]
  [string]$Owner = $env:FELIXAI_GITHUB_PACKAGES_OWNER,

  [Parameter(Mandatory = $false)]
  [string]$Username = $env:FELIXAI_GITHUB_PACKAGES_USERNAME,

  [Parameter(Mandatory = $false)]
  [string]$Token = $env:FELIXAI_GITHUB_PACKAGES_TOKEN,

  [Parameter(Mandatory = $false)]
  [string]$Version,

  [Parameter(Mandatory = $false)]
  [string]$SourceName = "felixai-github",

  [switch]$Global,

  [Parameter(Mandatory = $false)]
  [string]$ToolPath,

  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$feedScript = Join-Path $scriptDir "install-felixai-from-feed.ps1"

if ([string]::IsNullOrWhiteSpace($Owner)) {
  throw "GitHub Packages owner is required. Pass -Owner or set FELIXAI_GITHUB_PACKAGES_OWNER."
}

if ([string]::IsNullOrWhiteSpace($Username)) {
  $Username = $Owner
}

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "GitHub Packages token is required. Pass -Token or set FELIXAI_GITHUB_PACKAGES_TOKEN."
}

$feedUrl = "https://nuget.pkg.github.com/$Owner/index.json"
$args = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $feedScript,
  "-FeedUrl",
  $feedUrl,
  "-SourceName",
  $SourceName,
  "-Username",
  $Username,
  "-Token",
  $Token
)

if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $args += @("-Version", $Version)
}

if ($Global.IsPresent) {
  $args += "-Global"
} elseif (-not [string]::IsNullOrWhiteSpace($ToolPath)) {
  $args += @("-ToolPath", $ToolPath)
}

if ($SkipVerify.IsPresent) {
  $args += "-SkipVerify"
}

Write-Host "[felixai] installing FelixAI.Tool from GitHub Packages owner '$Owner'"
& powershell @args

if ($LASTEXITCODE -ne 0) {
  throw "GitHub Packages install failed."
}
