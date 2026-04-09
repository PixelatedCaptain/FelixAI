# FelixAI.Tool

Private NuGet-packaged distribution of the FelixAI CLI.

Requirements:

- Windows
- .NET SDK or runtime capable of running .NET tools
- Node.js 18+ available on `PATH`, or `FELIXAI_NODE_EXE` set explicitly
- Local Codex authentication already available on the machine

Recommended install flow for GitHub Packages under `PixelatedCaptain`:

```powershell
dotnet nuget add source "https://nuget.pkg.github.com/PixelatedCaptain/index.json" `
  --name "felixai-github" `
  --username "<github-username>" `
  --password "<classic-pat-with-read-packages>" `
  --store-password-in-clear-text

dotnet tool install --global FelixAI.Tool --add-source "felixai-github"
```

Optional helper-script install from a private feed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-feed.ps1 `
  -FeedUrl <feed-url> `
  -Global
```

Or from a downloaded package:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-package.ps1 `
  -PackagePath .\FelixAI.Tool.0.1.6.nupkg `
  -Global
```

Optional GitHub Packages helper-script install:

```powershell
$env:FELIXAI_GITHUB_PACKAGES_OWNER = "PixelatedCaptain"
$env:FELIXAI_GITHUB_PACKAGES_USERNAME = "<github-username>"
$env:FELIXAI_GITHUB_PACKAGES_TOKEN = "<classic-pat-with-read-packages>"

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-github-packages.ps1 `
  -Global
```

Run:

```powershell
felixai version
```
