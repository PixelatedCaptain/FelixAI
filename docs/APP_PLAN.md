# FelixAI Orchestrator App Plan

## Product definition

FelixAI Orchestrator is a locally installed CLI-driven orchestration engine that coordinates Codex CLI sessions against GitHub issues. It is intentionally separate from any relay, dashboard, or remote UI.
Its target operating model is issue-driven execution, not product planning: an app plan is prepared outside FelixAI, the resulting GitHub issues become the execution contract, and FelixAI schedules and reruns Codex sessions per issue until each issue is actually done.

## Scope

### In scope

- Local CLI commands
- GitHub issue intake and execution orchestration
- GitHub issue dependency and parallel-safety scheduling
- Repeated Codex CLI sessions per issue until done
- Two-phase issue lifecycle with implementation then validation/testing
- Isolated repo workspaces per issue session
- Short-lived branch creation per issue session
- Session lifecycle tracking
- State persistence and recovery
- Boundary-aware reissue and retry handling
- Merge-readiness tracking
- Operator visibility into live and archived issue runs

### Out of scope

- Relay
- Dashboards
- Mobile access
- Team auth
- Shared Codex account coordination for multiple users
- Public APIs
- Dev/test/prod promotion governance
- App planning and feature prioritization
- General-purpose natural-language repo assistant behavior
- Felix-owned backlog design

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

### Milestone 3: issue contract intake

- read prepared GitHub issues
- normalize issue metadata and dependencies
- validate execution metadata before starting

### Milestone 4: Codex issue execution

- launch real Codex CLI issue sessions
- track per-issue session state
- expose issue-run status locally

### Milestone 5: issue retry loop

- classify completion vs retry vs blocked
- continue running issue sessions until issue-done state is reached
- keep operator-controlled manual intervention available
- move issues through `ready-to-test` before final done/closure

### Milestone 6: merge readiness

- track completed branches
- highlight conflicts or pending review
- generate merge-ready summaries

### Milestone 7: hardening

- stronger validation
- config migration strategy
- error classification
- packaging polish

### Milestone 8: execution metadata and scheduling

- GitHub issue metadata contract
- dependency-aware issue wave scheduling
- repeated Codex CLI sessions per issue until done
- repo-scoped aggressive execution policy

## Current implementation status

- `init`: implemented
- `job start`: implemented
- `job status`: implemented
- `job list`: implemented
- `job resume`: implemented
- structured state store: implemented
- workspace isolation with Git worktrees: implemented
- Codex planner/executor adapter: partially implemented
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
- external app-plan preparation: required and intentionally outside FelixAI
- GitHub issue metadata contract for dependency/order/parallel safety: implemented
- issue-driven execution waves based on overlap/dependency analysis: implemented
- repeated issue execution until issue-done state is reached: implemented
- real Codex CLI parity for issue execution sessions: implemented for issue execution
- two-phase implementation/validation issue lifecycle: implemented
- done-state checking against GitHub issue closure/body contract: implemented

## Delivery tracking

- Detailed milestone and issue breakdown: [DELIVERY_PLAN.md](./DELIVERY_PLAN.md)

## Design constraints

- FelixAI orchestrates; Codex executes
- product and app planning are prepared outside FelixAI
- GitHub issues are the primary unit of orchestration
- issue-level metadata, not freeform prompt interpretation, should drive ordering and parallel safety
- implementation sessions should mark issues `ready-to-test`; validation sessions should add `done` and close/move the issue when tests pass
- each issue session gets its own workspace and branch
- state must survive process restarts
- relay requirements must not leak into this repo
- FelixAI must use one explicit Codex credential source per installation with no ambient fallback ambiguity
- aggressive execution policy such as turbo mode or subagent use should be repo-scoped policy, not hard-coded global behavior
- issue execution should use the same local Codex runtime characteristics the operator uses directly whenever feasible

## Relay boundary

- Team access, identity, and remote control belong to the separate relay project.
- FelixAI should not implement shared-account logic for multiple users.
- FelixAI runs with the Codex credentials configured for that local installation or host.
- The relay should own user authentication, authorization, attribution, and request routing.
- FelixAI should persist enough metadata that a relay can later record who requested a job and why.
