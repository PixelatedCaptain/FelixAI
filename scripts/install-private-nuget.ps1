param(
  [Parameter(Mandatory = $false)]
  [string]$FeedUrl = $env:FELIXAI_NUGET_FEED_URL,

  [Parameter(Mandatory = $false)]
  [string]$Version,

  [switch]$Global,

  [Parameter(Mandatory = $false)]
  [string]$ToolPath = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "tmp\tool-install-private"),

  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$toolProject = Join-Path $projectRoot "packaging\FelixAI.Tool\FelixAI.Tool.csproj"
$packageId = "FelixAI.Tool"

if ([string]::IsNullOrWhiteSpace($FeedUrl)) {
  throw "Feed URL is required. Pass -FeedUrl or set FELIXAI_NUGET_FEED_URL."
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  [xml]$toolProjectXml = Get-Content -Path $toolProject
  $Version = $toolProjectXml.Project.PropertyGroup.Version
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  throw "Version is required and could not be read from packaging\FelixAI.Tool\FelixAI.Tool.csproj."
}

$listArgs = @("tool", "list")
if ($Global.IsPresent) {
  $listArgs += "--global"
} else {
  New-Item -ItemType Directory -Path $ToolPath -Force | Out-Null
  $listArgs += @("--tool-path", $ToolPath)
}

$installedTools = & dotnet @listArgs | Out-String
$command = if ($installedTools -match "(?im)^\s*felixai\.tool\s+") { "update" } else { "install" }

$installArgs = @("tool", $command)
if ($Global.IsPresent) {
  $installArgs += @("--global", $packageId, "--add-source", $FeedUrl, "--version", $Version, "--ignore-failed-sources")
} else {
  $installArgs += @("--tool-path", $ToolPath, $packageId, "--add-source", $FeedUrl, "--version", $Version, "--ignore-failed-sources")
}

& dotnet @installArgs | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Failed to $command $packageId from '$FeedUrl'."
}

if ($SkipVerify.IsPresent) {
  return
}

$felixExecutable = if ($Global.IsPresent) { "felixai" } else { Join-Path $ToolPath "felixai.exe" }

Write-Host "[felixai] verifying install with: $felixExecutable version"
& $felixExecutable version | Out-Host

if ($LASTEXITCODE -ne 0) {
  throw "FelixAI install verification failed."
}
