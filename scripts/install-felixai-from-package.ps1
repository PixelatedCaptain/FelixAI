param(
  [Parameter(Mandatory = $false)]
  [string]$PackagePath,

  [Parameter(Mandatory = $false)]
  [string]$Version,

  [switch]$Global,

  [Parameter(Mandatory = $false)]
  [string]$ToolPath,

  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installScript = Join-Path $scriptDir "install-private-nuget.ps1"
$useGlobal = $Global.IsPresent

if (-not $useGlobal -and [string]::IsNullOrWhiteSpace($ToolPath)) {
  $useGlobal = $true
}

if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $PackagePath = Get-ChildItem -Path $PSScriptRoot -Filter "FelixAI.Tool.*.nupkg" | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
}

if ([string]::IsNullOrWhiteSpace($PackagePath) -or -not (Test-Path -LiteralPath $PackagePath)) {
  throw "Package path is required. Pass -PackagePath or place the .nupkg next to this script."
}

$resolvedPackagePath = (Resolve-Path $PackagePath).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
  $packageName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedPackagePath)
  if ($packageName -match '^FelixAI\.Tool\.(.+)$') {
    $Version = $Matches[1]
  }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  throw "Could not determine package version from '$resolvedPackagePath'. Pass -Version explicitly."
}

$feedRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("felixai-local-feed-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $feedRoot -Force | Out-Null
Copy-Item -LiteralPath $resolvedPackagePath -Destination (Join-Path $feedRoot ([System.IO.Path]::GetFileName($resolvedPackagePath))) -Force

try {
  $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installScript, "-FeedUrl", $feedRoot, "-Version", $Version)

  if ($useGlobal) {
    $args += "-Global"
  } elseif (-not [string]::IsNullOrWhiteSpace($ToolPath)) {
    $args += @("-ToolPath", $ToolPath)
  }

  if ($SkipVerify.IsPresent) {
    $args += "-SkipVerify"
  }

  Write-Host "[felixai] installing FelixAI.Tool from downloaded package '$resolvedPackagePath'"
  & powershell @args

  if ($LASTEXITCODE -ne 0) {
    throw "FelixAI install from downloaded package failed."
  }
}
finally {
  Remove-Item -LiteralPath $feedRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[felixai] install completed"
Write-Host "[felixai] next steps:"
Write-Host "[felixai]   felixai auth login"
Write-Host "[felixai]   felixai doctor"
