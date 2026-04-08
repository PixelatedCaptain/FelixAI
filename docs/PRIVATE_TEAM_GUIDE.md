# FelixAI Private Team Guide

This guide is for a small private team using FelixAI through the private NuGet package and the local Codex/ChatGPT login session.

## Requirements

- Windows
- .NET tool support
- Node.js 18+ on `PATH`, or `FELIXAI_NODE_EXE` set explicitly
- Codex/ChatGPT login already available on the machine
- Access to the private NuGet feed that hosts `FelixAI.Tool`

## Install and Update

Install FelixAI from the private feed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-feed.ps1 `
  -FeedUrl <feed-url> `
  -Global
```

Update FelixAI from the same feed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-feed.ps1 `
  -FeedUrl <feed-url> `
  -Global
```

If you distribute the `.nupkg` directly instead of using the feed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-package.ps1 `
  -PackagePath .\FelixAI.Tool.0.1.0.nupkg `
  -Global
```

Verify the install:

```powershell
felixai version
```

If the feed requires credentials, set these first:

```powershell
$env:FELIXAI_NUGET_USERNAME = "<username>"
$env:FELIXAI_NUGET_TOKEN = "<token>"
```

For GitHub Packages under `PixelatedCaptain`:

```powershell
$env:FELIXAI_GITHUB_PACKAGES_OWNER = "PixelatedCaptain"
$env:FELIXAI_GITHUB_PACKAGES_USERNAME = "<github-username>"
$env:FELIXAI_GITHUB_PACKAGES_TOKEN = "<classic-pat-with-read-packages>"

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-github-packages.ps1 `
  -Global
```

Publishing uses a PAT with `write:packages`:

```powershell
$env:FELIXAI_GITHUB_PACKAGES_OWNER = "PixelatedCaptain"
$env:FELIXAI_GITHUB_PACKAGES_TOKEN = "<classic-pat-with-write-packages>"
npm run publish:github
```

## Auth

FelixAI uses the local Codex session. It does not manage a separate team login.

```powershell
felixai auth login
felixai auth status
felixai auth logout
```

- `auth login` starts the Codex/ChatGPT sign-in flow.
- `auth status` shows whether the local Codex session is active.
- `auth logout` clears the stored Codex session for that machine.

## Preflight

Run a quick environment check before starting work:

```powershell
felixai doctor
```

`doctor` checks the local prerequisites FelixAI depends on, including Git, Codex, GitHub CLI, and common auth problems.

## First Run

Initialize a repo once:

```powershell
felixai init
```

Then start a job from the repo root:

```powershell
felixai job start --repo . --task "Describe the change you want"
```

Useful options:

```powershell
felixai job start --repo . --task "..." --require-clean
felixai job start --repo . --task "..." --issue 123 --issue 456
felixai job start --repo . --task-file .\felixai.task.json
```

## Normal Workflow

Inspect the job:

```powershell
felixai job status <job-id>
felixai job status <job-id> --json
felixai job list
```

Continue a paused job:

```powershell
felixai job resume <job-id>
```

Push completed branches:

```powershell
felixai job push <job-id>
```

Prepare pull request metadata or create PRs:

```powershell
felixai job pr <job-id>
```

Create a merge-candidate branch:

```powershell
felixai job merge <job-id>
```

Resolve conflicts in the merge candidate:

```powershell
felixai job resolve-conflicts <job-id>
```

## State Meanings

- `blocked`: Codex could not continue without operator action or review.
- `boundary`: Codex reached a natural stopping point and needs a manual resume.
- `conflict`: FelixAI detected merge conflicts in the merge-candidate workspace.
- `branch drift`: Codex moved the workspace off the assigned FelixAI branch. Treat this as a failure and inspect the job before retrying.

## Recommended Team Flow

1. Run `felixai doctor`.
2. Run `felixai auth status` if you are not sure the machine is logged in.
3. Start the job with `felixai job start`.
4. Check `felixai job status` until the job is completed or paused.
5. Push completed branches with `felixai job push`.
6. Create PR metadata with `felixai job pr`.
7. Use `felixai job merge` for merge-candidate validation.
8. If merge conflicts appear, run `felixai job resolve-conflicts`.

## What To Do When Something Goes Wrong

- If `doctor` warns about auth, fix the Codex or GitHub CLI session first.
- If a job pauses at a `boundary`, use `felixai job resume <job-id>`.
- If a job is `blocked`, inspect the job output and state before retrying.
- If a job reports `branch drift`, do not push or merge until the branch assignment problem is understood.
- If PR creation fails, check `gh auth status` and clear any invalid `GITHUB_TOKEN` that is taking precedence over a valid keyring login.

## Notes

- FelixAI is a local orchestrator, not a shared team control plane.
- The private feed is the distribution mechanism; Codex remains the active credential source on each machine.
- Keep this guide with the release notes so the team has one place to check for install and workflow expectations.
