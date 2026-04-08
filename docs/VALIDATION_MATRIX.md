# FelixAI Real-Repo Validation Matrix

## Purpose

Validate the packaged FelixAI tool against a small set of real repositories before each private-team release. The goal is to confirm that the end-to-end workflow works on representative repo shapes, not just on the synthetic test repo.

## Selection Rules

Use 2 to 3 real repositories that the team actually cares about. Pick repos that cover different task shapes:

- one docs-heavy repository
- one small application or library repository with code plus tests
- one repository where PR and merge-candidate flow matters

If only two repos are available, include at least one task that exercises `job push`, `job pr`, and `job merge` on the same repo.

## Matrix

| Repo | Task Type | Example Task | Required FelixAI Path | Expected Outcome | Record |
| --- | --- | --- | --- | --- | --- |
| `FelixAI-TestRepo` or other docs-focused real repo | Docs-only | Update README, usage notes, or setup docs without code changes | `auth login` -> `doctor` -> `job start` -> `job status` | Single work item or minimal plan, no no-op verification branch, clean completion | job ID, repo, task summary, planner summary, final status, follow-up issues |
| Small app/library repo | Code + test | Change one function or endpoint and update tests to match | `auth login` -> `job start` -> `job status` -> `job push` | One coherent work item preferred, or a safe split that does not overlap files | job ID, repo, task summary, work-item count, changed files, push status, follow-up issues |
| Same repo as above or another repo with active remote | PR path | Complete a task that should produce a GitHub PR | `job start` -> `job push` -> `job pr` | PR link created or a clear no-op skip reason if there are no changes | job ID, repo, branch name, PR URL or skip reason, follow-up issues |
| Repo with known branch contention or a synthetic conflict setup | Conflict resolution | Create a controlled conflicting change and resolve it | `job start` -> `job push` -> `job merge` -> `job resolve-conflicts` | Conflict is detected, then resolved or clearly blocked with actionable output | job ID, repo, merge branch, conflict files, resolution session ID, follow-up issues |

## What To Record

For each run, capture the following in the release notes or a tracking issue comment:

- job ID
- repository name and path
- task prompt
- task type
- planner summary
- number of work items
- branch names
- push status
- PR URL or skip/failure reason
- merge-candidate status
- conflict resolution status if applicable
- follow-up GitHub issues created from failures or gaps

## Suggested Run Order

1. Docs-only repo first
2. Code plus test repo second
3. PR path and merge path on the repo that is most representative of your team’s normal workflow
4. Conflict-resolution scenario last, because it is the most likely to need manual cleanup or follow-up

## Exit Criteria

Treat the private MVP as releaseable only if:

- the docs-only task completes without planner noise or no-op downstream work
- the code plus test task completes without branch drift or overlapping work-item confusion
- `job push` and `job pr` succeed on at least one real repo
- `job merge` produces the expected merge-candidate state
- `job resolve-conflicts` completes or fails with an explicit, actionable reason
- every failure found during the matrix has a tracked follow-up issue

## Run Log Template

```text
Repo:
Task:
Job ID:
Task Type:
Planner Summary:
Work Items:
Branches:
Push Status:
PR Result:
Merge Result:
Conflict Result:
Outcome:
Follow-up Issues:
Notes:
```
