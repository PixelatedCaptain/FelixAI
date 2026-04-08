$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$toolProject = Join-Path $projectRoot "packaging\FelixAI.Tool\FelixAI.Tool.csproj"

Push-Location $projectRoot
try {
  npm run build | Out-Host
  dotnet pack $toolProject -c Release | Out-Host
}
finally {
  Pop-Location
}
