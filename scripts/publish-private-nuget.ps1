param(
  [Parameter(Mandatory = $false)]
  [string]$FeedUrl = $env:FELIXAI_NUGET_FEED_URL,

  [Parameter(Mandatory = $false)]
  [string]$ApiKey = $env:FELIXAI_NUGET_API_KEY,

  [Parameter(Mandatory = $false)]
  [string]$PackagePath,

  [switch]$SkipPack
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$toolProject = Join-Path $projectRoot "packaging\FelixAI.Tool\FelixAI.Tool.csproj"
$packScript = Join-Path $scriptDir "pack-nuget-tool.ps1"

if ([string]::IsNullOrWhiteSpace($FeedUrl)) {
  throw "Feed URL is required. Pass -FeedUrl or set FELIXAI_NUGET_FEED_URL."
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "NuGet API key is required. Pass -ApiKey or set FELIXAI_NUGET_API_KEY."
}

[xml]$toolProjectXml = Get-Content -Path $toolProject
$packageId = $toolProjectXml.Project.PropertyGroup.PackageId
$version = $toolProjectXml.Project.PropertyGroup.Version

if ([string]::IsNullOrWhiteSpace($packageId) -or [string]::IsNullOrWhiteSpace($version)) {
  throw "Unable to read PackageId/Version from $toolProject."
}

if (-not $SkipPack.IsPresent) {
  & $packScript
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build and pack FelixAI.Tool."
  }
}

if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $PackagePath = Join-Path $projectRoot "tmp\nuget\$packageId.$version.nupkg"
}

if (-not (Test-Path -LiteralPath $PackagePath)) {
  throw "Package not found at '$PackagePath'."
}

Write-Host "[felixai] publishing package: $PackagePath"
Write-Host "[felixai] target feed: $FeedUrl"

dotnet nuget push $PackagePath --source $FeedUrl --api-key $ApiKey --skip-duplicate | Out-Host

if ($LASTEXITCODE -ne 0) {
  throw "NuGet publish failed."
}

Write-Host "[felixai] publish completed: $packageId $version"
