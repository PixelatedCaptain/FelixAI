# FelixAI Release Plan

## Goal

Move FelixAI from repo-only usage to a repeatable Windows-first install story without changing the local-agent product boundary.

## Release stages

### Stage 1: repo-backed developer release

- `npm install`
- `npm run build`
- local `node dist/cli.js ...` usage
- documented Codex auth prerequisites

### Stage 2: npm CLI package

- publish `felixai` as an npm package with a `bin` entry
- support `npm install -g` for local developer machines
- include post-install verification guidance
- keep published contents limited to the built CLI surface and top-level docs

### Stage 3: Windows packaging

- generate a standalone Windows artifact
- evaluate MSI versus packaged EXE for workstation/server installs
- define upgrade/uninstall behavior for persisted `.felixai` state

### Stage 4: distribution polish

- GitHub Releases artifacts
- WinGet manifest
- checksum/signing process
- versioned install docs

## Packaging requirements

- clean `dist` before compile so packaged output cannot contain stale artifacts
- preserve `.felixai/config.json`, state, logs, and workspaces across upgrades unless the operator explicitly removes them
- surface FelixAI version, config schema version, and state schema version from the CLI
- keep Codex credential source external to packaging so installs do not silently change auth mode
- document required runtime prerequisites clearly for each format

## Current packaging status

- `npm run build` performs a clean rebuild of `dist`
- `npm run pack:dry-run` validates the npm package surface locally
- `npm run release:windows` creates a versioned zip under `tmp/release`
- `npm run pack:nuget` produces a private-feed-ready `.nupkg` for `dotnet tool install`
- `npm run publish:nuget` publishes the private NuGet package to the configured feed
- `npm run install:nuget -- --global` installs or updates FelixAI from that feed and verifies `felixai version`
- npm publish, GitHub Releases publishing, and WinGet packaging remain operator-driven

## Private feed recommendation

For Pat's private group, the preferred path is:

1. Build FelixAI locally
2. Run `npm run pack:nuget`
3. Set `FELIXAI_NUGET_FEED_URL` and `FELIXAI_NUGET_API_KEY`
4. Run `npm run publish:nuget`
5. Run `npm run install:nuget -- --global`

Supporting docs:

- [Private team guide](./PRIVATE_TEAM_GUIDE.md)
- [Validation matrix](./VALIDATION_MATRIX.md)
- [Release checklist](./RELEASE_CHECKLIST.md)

Constraints:

- the package is a .NET launcher over the bundled Node CLI, not a native .NET implementation
- target machines still need Node.js 18+ available

## MVP recommendation

The first shippable path should be:

1. npm package with a stable `felixai` bin
2. GitHub Releases with zipped Windows build output
3. MSI/EXE evaluation after the npm path is proven

## Open decisions

- whether to bundle Node runtime for Windows desktop/server installs
- whether worktree cleanup helpers should be part of the first packaged release
- whether package install should create a bootstrap command shortcut or stay CLI-only
