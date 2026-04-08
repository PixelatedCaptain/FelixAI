param(
  [Parameter(Mandatory = $false)]
  [string]$FeedUrl = $env:FELIXAI_NUGET_FEED_URL,

  [Parameter(Mandatory = $false)]
  [string]$Version,

  [switch]$Global,

  [Parameter(Mandatory = $false)]
  [string]$ToolPath,

  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $scriptDir
$toolProject = Join-Path $projectRoot "packaging\FelixAI.Tool\FelixAI.Tool.csproj"
$packageId = "FelixAI.Tool"

if ([string]::IsNullOrWhiteSpace($ToolPath) -and -not $Global.IsPresent) {
  $ToolPath = Join-Path $projectRoot "tmp\tool-install-private"
}

function Get-InstalledToolPayloadPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $true)]
    [string]$PackageVersion
  )

  $candidate = Join-Path $InstallRoot ".store\felixai.tool\$PackageVersion\felixai.tool\$PackageVersion\tools\net8.0\any"
  if (Test-Path $candidate) {
    return (Resolve-Path $candidate).Path
  }

  return $null
}

function Assert-InstalledToolRuntimeFiles {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $true)]
    [string]$PackageVersion
  )

  $payloadPath = Get-InstalledToolPayloadPath -InstallRoot $InstallRoot -PackageVersion $PackageVersion
  if ([string]::IsNullOrWhiteSpace($payloadPath)) {
    throw "Installed tool payload path was not found under '$InstallRoot'."
  }

  $requiredFiles = @(
    "FelixAI.Tool.runtimeconfig.json",
    "FelixAI.Tool.deps.json",
    "FelixAI.Tool.dll",
    "dist\cli.js",
    "node_modules\@openai\codex-sdk\package.json",
    "node_modules\@openai\codex\package.json",
    "node_modules\@openai\codex-win32-x64\package.json",
    "node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe"
  )

  foreach ($relativePath in $requiredFiles) {
    $target = Join-Path $payloadPath $relativePath
    if (-not (Test-Path $target)) {
      throw "Installed tool is missing required runtime file '$relativePath' under '$payloadPath'."
    }
  }

  Write-Host "[felixai] verified installed tool payload: $payloadPath"
}

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

if (-not $Global.IsPresent) {
  Assert-InstalledToolRuntimeFiles -InstallRoot $ToolPath -PackageVersion $Version
}

Write-Host "[felixai] verifying install with: $felixExecutable version"
& $felixExecutable version | Out-Host

if ($LASTEXITCODE -ne 0) {
  throw "FelixAI install verification failed."
}
