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

- preserve `.felixai/config.json`, state, logs, and workspaces across upgrades unless the operator explicitly removes them
- surface FelixAI version, config schema version, and state schema version from the CLI
- keep Codex credential source external to packaging so installs do not silently change auth mode
- document required runtime prerequisites clearly for each format

## MVP recommendation

The first shippable path should be:

1. npm package with a stable `felixai` bin
2. GitHub Releases with zipped Windows build output
3. MSI/EXE evaluation after the npm path is proven

## Open decisions

- whether to bundle Node runtime for Windows desktop/server installs
- whether worktree cleanup helpers should be part of the first packaged release
- whether package install should create a bootstrap command shortcut or stay CLI-only
