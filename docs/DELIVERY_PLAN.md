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

## Milestone 3: GitHub Issue Contract Intake

### Goal

Turn prepared GitHub issues into an execution contract that Felix can schedule deterministically.

### Exit criteria

- issue metadata contract is documented and enforced
- invalid or missing dependency metadata is handled cleanly
- dependency graphs are normalized from issue bodies/labels
- issue snapshots and normalized execution state are persisted for later inspection

### Issues

10. GitHub issue execution-metadata contract
    Scope:
    Define the required issue-body execution metadata Felix expects, including lane, explicit dependencies, and done criteria, and validate it before execution.

11. Dependency graph validation and scheduling rules from issue metadata
    Scope:
    Detect missing dependencies, circular dependencies, invalid lane combinations, and invalid parallel eligibility before execution begins.

12. Issue snapshot artifacts and inspectability
    Scope:
    Persist normalized issue snapshots, execution metadata, and scheduling state so operators can inspect exactly what Felix will execute.

## Milestone 4: Codex CLI Issue Execution

### Goal

Execute real Codex CLI sessions in isolated workspaces with reliable tracking and operator visibility.

### Exit criteria

- parallel scheduling respects dependency rules
- Codex CLI sessions are tracked consistently
- job status reflects session reality
- operators can inspect current work item/session state from the CLI

### Issues

13. Codex CLI parity for Felix execution sessions
    Scope:
    Replace SDK-only worker execution with a Codex CLI execution path that preserves the operator's local Codex runtime characteristics as closely as possible.

14. Session lifecycle tracking and persistence
    Scope:
    Capture session IDs, attempts, prompts, summaries, timestamps, and state transitions in a consistent per-issue-session model.

15. CLI inspection improvements for jobs and sessions
    Scope:
    Expand `job status`, `job list`, and live watch output so operators can inspect issue-session states, session IDs, branch names, and startup/block/failure conditions quickly.

## Milestone 5: Issue Retry and Done-State Handling

### Goal

Make issue retries and done-state checks operationally trustworthy.

### Exit criteria

- completion vs retry vs blocked is classified consistently
- issue sessions can be reissued until the issue is actually done
- GitHub issue state is checked after each session
- manual intervention remains explicit when an issue cannot move forward

### Issues

16. Issue-lane retry controller and attempt policy
    Scope:
    Formalize issue-session retry behavior, operator-facing attempt counts, and escalation rules when progress stalls or the same failure repeats.

17. Done-state checking against GitHub issue state
    Scope:
    After each issue session, check whether the issue is actually done using GitHub closure, `done`/`ready-to-test` lifecycle labels, and documented done criteria, and continue or stop accordingly.

18. Two-phase issue lifecycle with validation handoff
    Scope:
    Use implementation sessions to move issues to `ready-to-test`, then run separate validation sessions that add missing focused tests, run relevant test coverage, and only then move issues to `done`.

19. Manual intervention and restart UX
    Scope:
    Improve operator messaging so it is obvious when Felix is continuing the same issue, starting a fresh issue session, or waiting for manual intervention.

## Milestone 6: Merge Readiness and GitHub Alignment

### Goal

Make completed task branches reviewable and ready for human-controlled integration.

### Exit criteria

- completed branches are tracked clearly
- merge readiness is summarized per job
- GitHub issue/branch traceability is supported
- conflict states are visible even if auto-resolution is not implemented yet

### Issues

20. Merge-readiness model and summaries
    Scope:
    Expand the current completed/pending branch tracking into a richer merge-readiness summary with job-level reporting.

21. GitHub issue and branch traceability metadata
    Scope:
    Add optional issue references and persist branch-to-task traceability so future relay/GitHub workflows can align naturally.

22. Conflict detection and operator surfacing
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

23. Test coverage expansion for planner, scheduler, workspace, and resume flows
    Scope:
    Add broader tests for dependency handling, invalid plans, workspace failures, resume boundaries, and config/state validation.

24. Version reporting and compatibility surface
    Scope:
    Expose FelixAI version, config schema version, and state schema version in a stable CLI-visible form.

25. Config and status inspection commands
    Scope:
    Add commands such as `felixai config show` and a machine-readable status output that future relay code can consume.

26. Installation and release packaging plan
    Scope:
    Document and prototype the path from repo-based usage to installable release artifacts for Windows-focused users.

## Milestone 8: Scoped Issue Orchestration

### Goal

Let FelixAI accept an external app plan expressed as well-structured GitHub issues and then drive issue-by-issue Codex execution until the issues are done.

### Exit criteria

- prepared GitHub issues can be fetched and summarized locally
- issue metadata can drive dependency and overlap scheduling
- FelixAI can schedule parallel-safe issue waves and sequential dependency chains
- FelixAI can keep reissuing Codex CLI issue sessions until an issue reaches a done state
- repo policy can control aggressive execution settings such as turbo mode and subagent use

### Issues

27. Replace mixed natural-language planning flows with explicit issue orchestration entry
    Scope:
    Narrow Felix input handling so the primary path is explicit issue orchestration against prepared GitHub issues, not freeform product planning or recommendation chat.

28. GitHub unfinished-issue discovery and local snapshotting
    Scope:
    Fetch unfinished GitHub issues for the current repo, normalize the issue data FelixAI needs, and persist an inspectable issue snapshot before planning begins.

29. Dependency-aware issue wave scheduler from metadata
    Scope:
    Build the scheduler around issue metadata and explicit dependencies so independent issues can run in parallel and ordered issues wait correctly.

30. Felix shell/operator model for busy execution plus secondary-shell monitoring
    Scope:
    Make the main shell intentionally busy during active execution and ensure `job list`, `job status`, and `job watch` in a second shell are reliable and easy to interpret.

31. Repeated issue execution until done
    Scope:
    Treat a GitHub issue as the durable orchestration unit and keep reissuing Codex CLI sessions for that issue until FelixAI determines the issue is actually done.

32. Repo-scoped execution policy in AGENTS.md
    Scope:
    Extend repo-root `AGENTS.md` handling so repos can opt into aggressive execution settings such as turbo mode and subagent encouragement without hard-coding those policies globally.

## Notes

- Merge automation, conflict resolution automation, and relay implementation remain outside the current completed scope.
- If the issue breakdown changes in GitHub, this document should be updated in the same change set.
