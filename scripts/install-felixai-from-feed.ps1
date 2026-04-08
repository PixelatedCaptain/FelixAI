param(
  [Parameter(Mandatory = $false)]
  [string]$FeedUrl = $env:FELIXAI_NUGET_FEED_URL,

  [Parameter(Mandatory = $false)]
  [string]$Version,

  [Parameter(Mandatory = $false)]
  [string]$SourceName = "felixai-private",

  [Parameter(Mandatory = $false)]
  [string]$Username = $env:FELIXAI_NUGET_USERNAME,

  [Parameter(Mandatory = $false)]
  [string]$Token = $env:FELIXAI_NUGET_TOKEN,

  [switch]$Global,

  [Parameter(Mandatory = $false)]
  [string]$ToolPath,

  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$installScript = Join-Path $scriptDir "install-private-nuget.ps1"
$packageId = "FelixAI.Tool"
$useGlobal = $Global.IsPresent

if (-not $useGlobal -and [string]::IsNullOrWhiteSpace($ToolPath)) {
  $useGlobal = $true
}

function Assert-CommandAvailable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CommandName,

    [Parameter(Mandatory = $true)]
    [string]$HelpMessage
  )

  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw $HelpMessage
  }
}

if ([string]::IsNullOrWhiteSpace($FeedUrl)) {
  throw "Feed URL is required. Pass -FeedUrl or set FELIXAI_NUGET_FEED_URL."
}

Assert-CommandAvailable -CommandName "dotnet" -HelpMessage ".NET SDK is required to install FelixAI as a tool."
Assert-CommandAvailable -CommandName "node" -HelpMessage "Node.js 18+ is required to run FelixAI after install."

if (-not [string]::IsNullOrWhiteSpace($Token)) {
  if ([string]::IsNullOrWhiteSpace($Username)) {
    $Username = "felixai"
  }

  $existingSource = & dotnet nuget list source | Out-String
  if ($existingSource -match "(?im)^\s*\d+\.\s+$([regex]::Escape($SourceName))\s+\[") {
    & dotnet nuget remove source $SourceName | Out-Null
  }

  & dotnet nuget add source $FeedUrl `
    --name $SourceName `
    --username $Username `
    --password $Token `
    --store-password-in-clear-text | Out-Host

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to configure NuGet source '$SourceName'."
  }

  $FeedUrl = $SourceName
}

$args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installScript, "-FeedUrl", $FeedUrl)

if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $args += @("-Version", $Version)
}

if ($useGlobal) {
  $args += "-Global"
} elseif (-not [string]::IsNullOrWhiteSpace($ToolPath)) {
  $args += @("-ToolPath", $ToolPath)
}

if ($SkipVerify.IsPresent) {
  $args += "-SkipVerify"
}

Write-Host "[felixai] installing $packageId from '$FeedUrl'"
& powershell @args

if ($LASTEXITCODE -ne 0) {
  throw "FelixAI install from feed failed."
}

Write-Host "[felixai] install completed"
Write-Host "[felixai] next steps:"
Write-Host "[felixai]   felixai auth login"
Write-Host "[felixai]   felixai doctor"
