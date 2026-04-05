# FelixAI Orchestrator

FelixAI Orchestrator is a local CLI-driven orchestration engine for large software tasks. It uses Codex both as the planning brain and the execution engine, while FelixAI manages jobs, isolated workspaces, short-lived branches, state, and resume behavior.

## What It Does

- Accepts a large engineering task from the CLI
- Uses Codex to decompose that task into structured work items
- Creates isolated Git workspaces and short-lived branches per work item
- Launches Codex sessions against those isolated workspaces
- Persists job, session, and event state under `.felixai/state`
- Supports boundary-aware manual resume and optional auto-resume
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

Codex CLI authentication must already be available locally, or `CODEX_API_KEY` must be set for the SDK environment.

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

FelixAI uses one explicit credential source at a time, configured in `.felixai/config.json`:

- `chatgpt-session`: use the local Codex/ChatGPT login session only
- `env-api-key`: use `OPENAI_API_KEY` only

The default is `chatgpt-session` so ambient shell API keys do not create ambiguity.

## CLI

```bash
felixai init
felixai job start --repo . --task "Build the first milestone"
felixai job status <job-id>
felixai job list
felixai job resume <job-id>
```

## Repo Docs

- [App plan](./docs/APP_PLAN.md)
- [Architecture](./docs/ARCHITECTURE.md)

## Current MVP Shape

1. CLI entrypoint and local install flow
2. Job and session state persistence
3. Codex planning into structured work items
4. Isolated Git workspaces and temporary branches
5. Multi-session orchestration with dependency-aware scheduling
6. Boundary-aware resume flow
