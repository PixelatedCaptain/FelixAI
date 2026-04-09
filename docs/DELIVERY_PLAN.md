# FelixAI Orchestrator Delivery Plan

This document turns the app plan into implementation milestones and concrete issue-level work. GitHub issues should mirror this document so the repo plan and GitHub tracking stay aligned.

## Milestone 1: Foundation and Product Guardrails

### Goal

Ship a stable local developer-facing shell for FelixAI with durable config, state, logging, and clear product boundaries.

### Exit criteria

- CLI commands are structured and documented
- config and state schemas are versioned
- credential source is explicit and deterministic
- logs and state are inspectable on disk
- repo docs clearly separate agent vs relay responsibilities

### Issues

1. CLI command framework and UX polish
   Scope:
   Finalize command layout, help output, argument validation, and error messages for `init`, `job start`, `job status`, `job list`, and `job resume`.

2. Config schema validation and migration hooks
   Scope:
   Add runtime validation for `.felixai/config.json`, reject invalid values cleanly, and add a schema version migration entrypoint for future config changes.

3. Job state schema validation and migration hooks
   Scope:
   Validate persisted job/session state on load, fail clearly on corruption, and add migration scaffolding for future state schema changes.

4. Structured logging and event formatting
   Scope:
   Add structured log records, per-job log files, event formatting rules, and log retention conventions under `.felixai/logs`.

5. Product boundary and credential model documentation
   Scope:
   Keep README and planning docs aligned on credential source enforcement and relay-vs-agent responsibility boundaries.

## Milestone 2: Repository and Workspace Orchestration

### Goal

Make isolated Git workspaces and short-lived branches production-grade enough for parallel local execution.

### Exit criteria

- repo validation is consistent and informative
- workspaces are created predictably
- branch naming is deterministic and traceable
- failures in workspace setup are classified and persisted

### Issues

6. Repository discovery and validation
   Scope:
   Validate repo path, git availability, base branch availability, dirty-state policy, and error classification for repo bootstrap before planning/execution starts.

7. Workspace lifecycle manager hardening
   Scope:
   Expand worktree handling to cover existing workspaces, cleanup strategy, reattachment behavior, and repeated runs against the same repo.

8. Branch naming strategy and metadata traceability
   Scope:
   Formalize branch naming with task/session/run identifiers and persist enough metadata for GitHub and relay attribution later.

9. Workspace and git failure classification
   Scope:
   Distinguish recoverable vs blocking Git/workspace errors and persist actionable diagnostics into job events and logs.

## Milestone 3: Codex Planning Integration

### Goal

Turn large user tasks into structured work items reliably enough to drive parallel execution.

### Exit criteria

- planning prompt and schema are stable
- invalid planner output is handled cleanly
- dependency graphs are normalized
- planning artifacts are persisted for later inspection

### Issues

10. Planner prompt contract and output normalization
    Scope:
    Refine the planner prompt, normalize returned work items, enforce IDs/titles/prompts/dependencies, and reject malformed plans clearly.

11. Dependency graph validation and scheduling rules
    Scope:
    Detect duplicate IDs, missing dependencies, circular dependencies, and invalid parallel eligibility before execution begins.

12. Planning artifacts and inspectability
    Scope:
    Persist raw planner summaries and normalized work-item plans so operators can inspect exactly what Codex proposed.

## Milestone 4: Multi-Session Execution

### Goal

Execute multiple Codex sessions in isolated workspaces with reliable tracking and operator visibility.

### Exit criteria

- parallel scheduling respects dependency rules
- sessions are tracked consistently
- job status reflects session reality
- operators can inspect current work item/session state from the CLI

### Issues

13. Parallel scheduler and worker coordination
    Scope:
    Replace the simple fixed-slice executor with a clearer scheduler loop that manages ready queues, in-flight sessions, and dependency-aware dispatch.

14. Session lifecycle tracking and persistence
    Scope:
    Capture session IDs, attempts, prompts, summaries, timestamps, and state transitions in a consistent per-work-item model.

15. CLI inspection improvements for jobs and sessions
    Scope:
    Expand `job status` and `job list` output so operators can inspect work-item states, session IDs, branch names, and boundary/failure conditions quickly.

## Milestone 5: Resume and Boundary Handling

### Goal

Make boundary returns, retries, and resumes operationally trustworthy.

### Exit criteria

- completion vs boundary vs failure is classified consistently
- auto-resume behavior is configurable and observable
- manual resume is reliable
- replacement-session fallback rules are defined even if not fully automated

### Issues

16. Execution result classification and retry policy
    Scope:
    Formalize expected statuses, retryability, manual-review conditions, and operator-facing messaging for completion, boundary, blocked, and failed outcomes.

17. Auto-resume controller hardening
    Scope:
    Tighten auto-resume behavior, attempt counting, persisted next prompts, and max-resume enforcement per work item.

18. Manual resume and session continuity UX
    Scope:
    Improve resume behavior and operator messaging so it is obvious when FelixAI is continuing the same session versus falling back to a new one later.

## Milestone 6: Merge Readiness and GitHub Alignment

### Goal

Make completed task branches reviewable and ready for human-controlled integration.

### Exit criteria

- completed branches are tracked clearly
- merge readiness is summarized per job
- GitHub issue/branch traceability is supported
- conflict states are visible even if auto-resolution is not implemented yet

### Issues

19. Merge-readiness model and summaries
    Scope:
    Expand the current completed/pending branch tracking into a richer merge-readiness summary with job-level reporting.

20. GitHub issue and branch traceability metadata
    Scope:
    Add optional issue references and persist branch-to-task traceability so future relay/GitHub workflows can align naturally.

21. Conflict detection and operator surfacing
    Scope:
    Detect likely merge conflicts or integration blockers and surface them clearly in state, logs, and CLI output.

## Milestone 7: Hardening and Release Readiness

### Goal

Prepare FelixAI for repeatable local use and an eventual stable MVP release.

### Exit criteria

- packaging/install guidance is solid
- tests cover critical flows
- version reporting is exposed
- operational status/config inspection exists for future relay integration

### Issues

22. Test coverage expansion for planner, scheduler, workspace, and resume flows
    Scope:
    Add broader tests for dependency handling, invalid plans, workspace failures, resume boundaries, and config/state validation.

23. Version reporting and compatibility surface
    Scope:
    Expose FelixAI version, config schema version, and state schema version in a stable CLI-visible form.

24. Config and status inspection commands
    Scope:
    Add commands such as `felixai config show` and a machine-readable status output that future relay code can consume.

25. Installation and release packaging plan
    Scope:
    Document and prototype the path from repo-based usage to installable release artifacts for Windows-focused users.

## Milestone 8: Issue-Driven Orchestration

### Goal

Let FelixAI accept a natural-language directive, review unfinished GitHub issues through Codex, build an execution order, and then drive issue-by-issue Codex execution until the issues are done.

### Exit criteria

- natural-language CLI intake can start an issue-driven orchestration run
- unfinished GitHub issues can be fetched and summarized locally
- Codex can return an issue ordering with dependency and overlap guidance
- FelixAI can schedule parallel-safe issue waves and sequential dependency chains
- FelixAI can keep resuming an issue until it reaches a done state
- repo policy can control aggressive execution settings such as turbo mode and subagent use

### Issues

26. Natural-language CLI intake for issue-driven runs
    Scope:
    Add a top-level natural-language CLI entry point that can infer the current repo, capture a freeform orchestration directive, and route it into FelixAI without requiring `job start --repo ... --task ...`.

27. GitHub unfinished-issue discovery and local snapshotting
    Scope:
    Fetch unfinished GitHub issues for the current repo, normalize the issue data FelixAI needs, and persist an inspectable issue snapshot before planning begins.

28. Codex issue-order planning contract
    Scope:
    Define the prompt and schema for asking Codex to review unfinished issues and return an execution order with dependency, overlap-risk, and parallel-safety metadata.

29. Issue-wave scheduler for dependency-aware parallel execution
    Scope:
    Schedule issue execution in safe parallel waves when issues do not overlap, and force sequential processing when Codex marks dependency or overlap risk.

30. Repeated issue execution until done
    Scope:
    Treat a GitHub issue as the durable orchestration unit and keep resuming or reissuing Codex sessions for that issue until FelixAI determines the issue is actually done.

31. Repo-scoped execution policy in AGENTS.md
    Scope:
    Extend repo-root `AGENTS.md` handling so repos can opt into aggressive execution settings such as turbo mode and subagent encouragement without hard-coding those policies globally.

## Notes

- Merge automation, conflict resolution automation, and relay implementation remain outside the current completed scope.
- If the issue breakdown changes in GitHub, this document should be updated in the same change set.
