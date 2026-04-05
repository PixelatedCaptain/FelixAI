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

- By default, dirty working trees are allowed.
- Use `--require-clean` on `job start` to block execution when the repo has uncommitted changes.

## Issue traceability

- Use `--issue <id>` on `job start` to attach one or more issue references to the job.
- Planner work items can also include issue references.
- FelixAI carries issue references into persisted state, CLI output, and branch naming when available.

## GitHub alignment

- FelixAI records per-branch remote metadata, including preferred remote name, remote branch name, and local-vs-remote push status.
- Remote metadata is derived from local Git refs, so it works without requiring a live GitHub API call during job inspection.
- FelixAI also derives per-issue run summaries that aggregate work items, branches, and latest work-item responses for relay-side display later.
- `felixai job push <job-id>` pushes completed work-item branches and refreshes remote tracking state.

## Merge automation

- `felixai job merge <job-id>` creates a merge-candidate branch off the target branch rather than merging directly into the base branch.
- FelixAI attempts merges sequentially into that candidate branch and records either a merged result or explicit conflict details.
- Conflict results are preserved in job state so a future relay or local operator can inspect the candidate branch and decide what to do next.

## Workspace lifecycle

- FelixAI prunes stale worktree registrations before preparing a workspace.
- If a matching worktree already exists, FelixAI reuses or reattaches it instead of blindly creating a duplicate.
- If the target workspace path already exists with conflicting contents, FelixAI classifies that as a workspace conflict and persists the failure details.

## Repo Docs

- [App plan](./docs/APP_PLAN.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Release plan](./docs/RELEASE_PLAN.md)

## Current MVP Shape

1. CLI entrypoint and local install flow
2. Job and session state persistence
3. Codex planning into structured work items
4. Isolated Git workspaces and temporary branches
5. Multi-session orchestration with dependency-aware scheduling
6. Boundary-aware resume flow
