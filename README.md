# FelixAI Orchestrator

FelixAI Orchestrator is a local CLI-driven orchestration engine for large software tasks. It uses Codex both as the planning brain and the execution engine, while FelixAI manages jobs, isolated workspaces, short-lived branches, state, and resume behavior.

## What It Does

- Accepts a large engineering task from the CLI
- Uses Codex to decompose that task into structured work items
- Creates isolated Git workspaces and short-lived branches per work item
- Launches Codex sessions against those isolated workspaces
- Persists job, session, and event state under `.felixai/state`
- Supports boundary-aware manual resume and optional auto-resume
- Distinguishes resume boundaries from blocked/manual-review execution results
- Exposes local operational commands for start, resume, status, and listing jobs

## What It Does Not Do

- No relay
- No dashboard or web UI
- No remote control plane
- No public auth flows
- No long-lived environment promotion automation

## Install

```bash
npm install
npm run build
```

Codex authentication must already be available locally. FelixAI is intentionally Codex-session only and does not use API-key auth.
The build now clears `dist/` first so compiled output matches the current `src/` tree.

## Packaging

For npm package validation:

```bash
npm run pack:dry-run
```

For a Windows zip artifact containing the built CLI:

```bash
npm run release:windows
```

This writes a versioned zip under `tmp/release/`.

For a private NuGet package that can be installed as a .NET tool:

```bash
npm run pack:nuget
```

This writes a `.nupkg` under `tmp/nuget/`.

To publish that package to your private feed:

```powershell
$env:FELIXAI_NUGET_FEED_URL = "<feed-url>"
$env:FELIXAI_NUGET_API_KEY = "<api-key>"
npm run publish:nuget
```

To install or update FelixAI from the same feed with a verification step:

```powershell
$env:FELIXAI_NUGET_FEED_URL = "<feed-url>"
npm run install:nuget -- --global
```

Optional helper for a teammate-friendly install bootstrap from a private feed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-feed.ps1 `
  -FeedUrl "<feed-url>" `
  -Global
```

If the feed requires credentials, set `FELIXAI_NUGET_USERNAME` and `FELIXAI_NUGET_TOKEN` first or pass `-Username` and `-Token`.

For GitHub Packages under `PixelatedCaptain`:

```powershell
$env:FELIXAI_GITHUB_PACKAGES_OWNER = "PixelatedCaptain"
$env:FELIXAI_GITHUB_PACKAGES_USERNAME = "<github-username>"
$env:FELIXAI_GITHUB_PACKAGES_TOKEN = "<classic-pat>"

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-github-packages.ps1 `
  -Global
```

For a downloaded package install:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-package.ps1 `
  -PackagePath .\FelixAI.Tool.0.1.6.nupkg `
  -Global
```

## Private NuGet Install

FelixAI can be distributed through a private NuGet feed as a .NET tool wrapper around the bundled Node CLI.

Requirements on the target machine:

- .NET tool support
- Node.js 18+ on `PATH`

Recommended install flow for teammates:

1. Add the NuGet source once on the machine.
2. Install or update FelixAI with `dotnet tool`.

For GitHub Packages under `PixelatedCaptain`, add the source once:

```powershell
dotnet nuget add source "https://nuget.pkg.github.com/PixelatedCaptain/index.json" `
  --name "felixai-github" `
  --username "<github-username>" `
  --password "<classic-pat-with-read-packages>" `
  --store-password-in-clear-text
```

Then install FelixAI:

```powershell
dotnet tool install --global FelixAI.Tool --add-source "felixai-github" --version 0.1.6
```

Update FelixAI later with:

```powershell
dotnet tool update --global FelixAI.Tool --add-source "felixai-github" --version 0.1.6
```

Optional helper-script install from your private feed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-feed.ps1 `
  -FeedUrl <your-feed> `
  -Global
```

Optional helper-script install from a downloaded package:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-package.ps1 `
  -PackagePath .\FelixAI.Tool.0.1.6.nupkg `
  -Global
```

If Node is installed in a non-standard location, set `FELIXAI_NODE_EXE` before running `felixai`.

## GitHub Packages

For a GitHub-hosted private NuGet feed under `PixelatedCaptain`, the feed URL is:

```text
https://nuget.pkg.github.com/PixelatedCaptain/index.json
```

Install from GitHub Packages with the helper script:

```powershell
$env:FELIXAI_GITHUB_PACKAGES_OWNER = "PixelatedCaptain"
$env:FELIXAI_GITHUB_PACKAGES_USERNAME = "<github-username>"
$env:FELIXAI_GITHUB_PACKAGES_TOKEN = "<classic-pat-with-read-packages>"

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-felixai-from-github-packages.ps1 `
  -Global
```

Publish to GitHub Packages:

```powershell
$env:FELIXAI_GITHUB_PACKAGES_OWNER = "PixelatedCaptain"
$env:FELIXAI_GITHUB_PACKAGES_TOKEN = "<classic-pat-with-write-packages>"
npm run publish:github
```

GitHub's NuGet registry uses personal access tokens (classic). Private installs need `read:packages`; publishing needs `write:packages`. If the package is associated with a private repository, the account also needs repository access.

## Bootstrap

```bash
felixai init
felixai init --force
```

This creates:

- `.felixai/config.json`
- `.felixai/state/`
- `.felixai/workspaces/`
- `.felixai/logs/`

## Credentials

FelixAI uses the local Codex session only, configured as `codex` in `.felixai/config.json`.
Ambient API-key auth is intentionally ignored so local behavior stays aligned with Codex.
Use `felixai auth login` to start Codex login, `felixai auth status` to inspect the active login, and `felixai auth logout` to sign out.
Codex owns the stored session under the local `~/.codex` state, and FelixAI reuses that session until you explicitly sign out.
Use `felixai doctor` before running jobs if you want a quick preflight over Codex, Git, GitHub CLI, and common auth conflicts.

## CLI

```bash
felixai auth login
felixai auth status
felixai auth logout
felixai doctor
felixai init
felixai config show
felixai version
felixai job start --repo . --task "Build the first milestone"
felixai job start --repo . --task-file ./felixai.task.json
felixai job start --repo . --task "Refactor auth" --require-clean
felixai job start --repo . --task "Implement issue" --issue 142 --issue api-hardening
felixai job status <job-id>
felixai job status <job-id> --json
felixai job push <job-id>
felixai job merge <job-id> --target-branch main
felixai job pr <job-id>
felixai job resolve-conflicts <job-id>
felixai job list
felixai job list --json
felixai job resume <job-id>
```

## Logging

FelixAI persists:

- job state under `.felixai/state/jobs`
- normalized planner artifacts under `.felixai/state/plans`
- per-job event logs under `.felixai/logs/jobs/*.events.jsonl`
- per-job log summaries under `.felixai/logs/jobs/*.summary.json`

`job status` also surfaces merge-readiness hints for completed branches, including likely overlaps in changed files.
It also persists per-branch remote push status and issue-linked run summaries for later relay/dashboard use.
Workspace setup and execution failures are classified and persisted so operators can see whether a condition is retryable or needs manual review.
Merge automation attempts are persisted separately from merge-readiness analysis so operators can inspect candidate-branch results and conflicts after the fact.

## Repo policy

FelixAI validates that the target path is a Git repository and that the selected base branch exists.
When a repo contains a root-level `AGENTS.md`, FelixAI automatically reads it during jobs and passes that guidance through to the planner and executor.
That same `AGENTS.md` file can also carry repo-scoped FelixAI run defaults such as `model:`, `reasoning_effort:`, `turbo_mode:`, and `encourage_subagents:`.
When FelixAI needs a repo model interactively, it reads Codex's local dynamic model catalog from `~/.codex/models_cache.json` and shows a numbered selection list instead of taking a raw free-text model.
If an existing `AGENTS.md` model is missing from the current Codex model catalog or fails at runtime, FelixAI prompts for a replacement and updates the `model:` line in place.

- By default, dirty working trees are allowed.
- Use `--require-clean` on `job start` to block execution when the repo has uncommitted changes.

Example repo defaults in `AGENTS.md`:

```md
model: gpt-5.4
reasoning_effort: high
turbo_mode: enabled
encourage_subagents: enabled
```

## Issue traceability

- Use `--issue <id>` on `job start` to attach one or more issue references to the job.
- Planner work items can also include issue references.
- FelixAI carries issue references into persisted state, CLI output, and branch naming when available.

## Issue Planning

FelixAI can snapshot unfinished GitHub issues for the current repo and ask Codex to produce a dependency-aware execution order:

```powershell
felixai issues snapshot --repo .
felixai issues plan --repo . --directive "Review unfinished issues and choose the safest implementation order"
felixai issues run --repo . --directive "Review unfinished issues and start processing them in dependency order"
felixai review all github issues that are not done and figure out the best order to complete them, then start processing them
felixai tell me about this repo
```

Issue snapshots, issue plans, and issue-run state are persisted under `.felixai/state/issues/`.

For non-orchestration prompts, FelixAI now falls back to a single Codex repo session and returns the result directly.

## GitHub alignment

- FelixAI records per-branch remote metadata, including preferred remote name, remote branch name, and local-vs-remote push status.
- Remote metadata is derived from local Git refs, so it works without requiring a live GitHub API call during job inspection.
- FelixAI also derives per-issue run summaries that aggregate work items, branches, and latest work-item responses for relay-side display later.
- `felixai job push <job-id>` pushes completed work-item branches and refreshes remote tracking state.
- `felixai job pr <job-id>` prepares issue-aware pull request metadata and can create GitHub pull requests when `gh` is available and authenticated.

## Merge automation

- `felixai job merge <job-id>` creates a merge-candidate branch off the target branch rather than merging directly into the base branch.
- FelixAI attempts merges sequentially into that candidate branch and records either a merged result or explicit conflict details.
- Conflict results are preserved in job state so a future relay or local operator can inspect the candidate branch and decide what to do next.
- `felixai job resolve-conflicts <job-id>` re-enters the merge-candidate workspace and runs a Codex-assisted conflict-resolution pass, preserving the resolution session and summary.

## Workspace lifecycle

- FelixAI prunes stale worktree registrations before preparing a workspace.
- If a matching worktree already exists, FelixAI reuses or reattaches it instead of blindly creating a duplicate.
- If the target workspace path already exists with conflicting contents, FelixAI classifies that as a workspace conflict and persists the failure details.

## Repo Docs

- [App plan](./docs/APP_PLAN.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Release plan](./docs/RELEASE_PLAN.md)
- [Private team guide](./docs/PRIVATE_TEAM_GUIDE.md)
- [Validation matrix](./docs/VALIDATION_MATRIX.md)
- [Release checklist](./docs/RELEASE_CHECKLIST.md)

## Current MVP Shape

1. CLI entrypoint and local install flow
2. Job and session state persistence
3. Codex planning into structured work items
4. Isolated Git workspaces and temporary branches
5. Multi-session orchestration with dependency-aware scheduling
6. Boundary-aware resume flow
7. Deterministic local build and package artifacts
