# FelixAI.Tool

Private NuGet-packaged distribution of the FelixAI CLI.

Requirements:

- Windows
- .NET SDK or runtime capable of running .NET tools
- Node.js 18+ available on `PATH`, or `FELIXAI_NODE_EXE` set explicitly
- Local Codex authentication already available on the machine

Install from a private feed:

```powershell
dotnet tool install --global FelixAI.Tool --add-source <feed-url>
```

Or from the FelixAI repo with the helper script:

```powershell
$env:FELIXAI_NUGET_FEED_URL = "<feed-url>"
npm run install:nuget -- --global
```

Run:

```powershell
felixai version
```
