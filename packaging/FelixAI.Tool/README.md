# FelixAI.Tool

Private NuGet-packaged distribution of the FelixAI CLI.

Requirements:

- Windows
- .NET SDK or runtime capable of running .NET tools
- Node.js 18+ available on `PATH`, or `FELIXAI_NODE_EXE` set explicitly
- Local Codex authentication already available on the machine

Install from a private feed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-feed.ps1 `
  -FeedUrl <feed-url> `
  -Global
```

Or from a downloaded package:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-package.ps1 `
  -PackagePath .\FelixAI.Tool.0.1.0.nupkg `
  -Global
```

Run:

```powershell
felixai version
```
