# FelixAI Orchestrator App Plan

## Product definition

FelixAI Orchestrator is a locally installed CLI-driven orchestration engine that coordinates multiple Codex CLI sessions to complete large software engineering tasks in parallel. It is intentionally separate from any relay, dashboard, or remote UI.
Its target operating model is issue-driven orchestration: FelixAI should be able to review unfinished GitHub issues, ask Codex to propose the safest execution order, and then run one or more Codex sessions per issue until each issue is actually done.

## Scope

### In scope

- Local CLI commands
- High-level task intake
- Natural-language task intake
- Codex-driven task decomposition
- GitHub issue intake and prioritization
- Isolated repo workspaces per session
- Short-lived branch creation per work item
- Session lifecycle tracking
- State persistence and recovery
- Boundary-aware auto-resume or manual resume
- Merge-readiness tracking

### Out of scope

- Relay
- Dashboards
- Mobile access
- Team auth
- Shared Codex account coordination for multiple users
- Public APIs
- Dev/test/prod promotion governance

## MVP milestones

### Milestone 1: foundation

- local installable CLI
- config file and directories
- versioned state model
- basic logging

### Milestone 2: repo orchestration

- Git repo validation
- isolated workspace creation
- temporary branch naming
- base branch selection

### Milestone 3: planning

- send large task to Codex planner
- receive structured work items
- normalize dependencies

### Milestone 4: execution

- launch multiple Codex sessions
- track session and work-item state
- expose job status locally

### Milestone 5: resume

- classify completion vs boundary vs failure
- auto-resume support
- manual resume command

### Milestone 6: merge readiness

- track completed branches
- highlight conflicts or pending review
- generate merge-ready summaries

### Milestone 7: hardening

- stronger validation
- config migration strategy
- error classification
- packaging polish

### Milestone 8: issue-driven orchestration

- natural-language CLI entry point
- GitHub unfinished-issue discovery
- Codex issue ordering and dependency planning
- parallel-safe issue wave scheduling
- repeated Codex sessions per issue until done

## Current implementation status

- `init`: implemented
- `job start`: implemented
- `job status`: implemented
- `job list`: implemented
- `job resume`: implemented
- structured state store: implemented
- workspace isolation with Git worktrees: implemented
- Codex planner/executor adapter: implemented
- dependency-aware in-flight scheduler: implemented
- issue-linked branch traceability: implemented
- persisted remote branch/push metadata: implemented
- per-issue run summaries for relay consumption: implemented
- workspace reuse/reattachment and conflict classification: implemented
- blocked/manual-review execution classification: implemented
- branch push execution from the CLI: implemented
- merge-candidate automation with persisted conflict state: implemented
- pull request linkage and issue-aware PR metadata: implemented
- conflict-resolution workflow on merge candidates: implemented
- repo-root `AGENTS.md` ingestion for planner/executor prompts: implemented
- repo-root `AGENTS.md` model and reasoning defaults: implemented
- direct-to-base merge automation: not yet implemented
- automatic conflict resolution remains best-effort and operator-reviewed
- natural-language CLI intake: not yet implemented
- GitHub unfinished-issue planning and prioritization: not yet implemented
- issue-driven execution waves based on overlap/dependency analysis: not yet implemented
- repeated issue execution until issue-done state is reached: not yet implemented

## Delivery tracking

- Detailed milestone and issue breakdown: [DELIVERY_PLAN.md](./DELIVERY_PLAN.md)

## Design constraints

- FelixAI orchestrates; Codex plans and executes
- GitHub issues are the preferred unit of orchestration when a repo uses issue-driven mode
- each work item gets its own workspace and branch
- issue-level orchestration should only split an issue into smaller work items when the issue is not already a small, well-defined implementation unit
- state must survive process restarts
- relay requirements must not leak into this repo
- FelixAI must use one explicit Codex credential source per installation with no ambient fallback ambiguity
- aggressive execution policy such as turbo mode or subagent use should be repo-scoped policy, not hard-coded global behavior

## Relay boundary

- Team access, identity, and remote control belong to the separate relay project.
- FelixAI should not implement shared-account logic for multiple users.
- FelixAI runs with the Codex credentials configured for that local installation or host.
- The relay should own user authentication, authorization, attribution, and request routing.
- FelixAI should persist enough metadata that a relay can later record who requested a job and why.
