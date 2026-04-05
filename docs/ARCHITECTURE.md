# FelixAI Orchestrator Architecture

## Core components

### CLI entrypoint

Parses local commands and delegates to the job manager.

### Job manager

Owns parent job creation, planning, scheduling, status transitions, and resume behavior.

### Codex adapter

Encapsulates Codex SDK usage for:

- planner turns
- execution turns
- same-thread resume
- explicit credential-source enforcement

## Credential model

- FelixAI must run with one configured credential source per installation.
- Supported modes are `chatgpt-session` and `env-api-key`.
- `chatgpt-session` must ignore ambient `OPENAI_API_KEY` values.
- `env-api-key` must fail fast if `OPENAI_API_KEY` is missing.
- Credential selection belongs to local agent configuration, while multi-user access belongs to the future relay.

### Workspace manager

Creates one isolated Git worktree per work item and assigns a short-lived branch.

### State store

Persists config, jobs, work items, sessions, and event history as JSON on disk.

### Resume controller

Decides whether a boundary result should be auto-resumed or paused for manual review.

## State model

Each job persists:

- job metadata
- source repo and base branch
- planner summary
- work items and dependency graph
- session metadata per work item
- event timeline
- merge-readiness summary

## Execution flow

1. User submits a high-level task with `felixai job start`
2. FelixAI asks Codex for a structured plan
3. FelixAI stores the plan and creates work items
4. FelixAI creates isolated Git worktrees and branches
5. FelixAI starts Codex execution sessions for eligible work items
6. FelixAI records completion, boundary, pause, or failure
7. FelixAI auto-resumes boundary items if configured
8. User can inspect or resume the job later from persisted state

## Persistence layout

Under `.felixai/`:

- `config.json`
- `state/jobs/<job-id>.json`
- `workspaces/<job-id>/<work-item-id>/`
- `logs/`

## Near-term gaps

- merge conflict automation
- branch push workflow
- GitHub issue materialization
- richer log export
- packaging for MSI/EXE/WinGet

## Responsibility boundary with relay

- FelixAI is the local execution engine.
- The future relay is responsible for multi-user access, remote triggering, dashboards, and identity.
- Shared team use of a Codex-backed installation should be governed by the relay layer, not by FelixAI itself.
- FelixAI should expose stable job/session metadata so relay-side attribution can be layered on later.
