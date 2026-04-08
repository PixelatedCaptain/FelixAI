# FelixAI Release Checklist

Use this checklist before publishing a private FelixAI build to the team.

## Scope

This checklist applies to internal/private releases only.

## Preflight

- [ ] `felixai doctor` reports no blocking issues.
- [ ] Codex login is active for the intended account.
- [ ] GitHub CLI auth is not conflicted by an invalid `GITHUB_TOKEN`.
- [ ] `node` is available on `PATH` or `FELIXAI_NODE_EXE` is set.
- [ ] The repo builds cleanly from source.
- [ ] The packaged tool was rebuilt after the last code change.

## Packaged-tool validation

- [ ] `npm run pack:nuget` completes successfully.
- [ ] The generated `.nupkg` is present under `tmp/nuget/`.
- [ ] The tool installs from the private feed without manual file copies.
- [ ] `felixai version` works from the installed tool.
- [ ] `felixai init` works from the installed tool.
- [ ] `felixai config show` works from the installed tool.

## Job flow validation

- [ ] `felixai job start` works on a real repo and creates a job.
- [ ] `felixai job status <job-id>` shows expected state.
- [ ] `felixai job resume <job-id>` works when a boundary is reached.
- [ ] `felixai job push <job-id>` pushes completed branches.
- [ ] `felixai job pr <job-id>` creates or links pull requests correctly.
- [ ] `felixai job merge <job-id>` creates a merge candidate successfully.

## Conflict-resolution validation

- [ ] If the job can conflict, run `felixai job resolve-conflicts <job-id>`.
- [ ] The conflict-resolution workspace returns to a clean merged state or reports remaining conflicts clearly.
- [ ] The merge status is not reported as merged until the merge commit actually exists.
- [ ] Branch drift, no-op branches, and stale remote status are surfaced clearly if encountered.

## Real-repo smoke matrix

- [ ] One docs-only task completed successfully.
- [ ] One code-plus-test task completed successfully.
- [ ] One job exercised the push, PR, and merge path.
- [ ] One intentional conflict case was exercised if available.
- [ ] Job IDs and follow-up notes were recorded for each run.

## Release go/no-go

Release is ready only if all of the following are true:

- [ ] All blocking checks above passed.
- [ ] No new regressions were found in the real-repo smoke matrix.
- [ ] Any known limitations are documented for the team.
- [ ] The version being published is recorded in the release notes or rollout message.
- [ ] The private feed package was validated on at least one clean machine or clean install path.

## Stop Conditions

Do not publish if any of these are true:

- [ ] `felixai doctor` reports a blocking auth or environment issue.
- [ ] `job pr` fails for reasons other than a known, documented repository problem.
- [ ] `job merge` or `job resolve-conflicts` leaves the merge state inconsistent.
- [ ] A job produces branch drift, but the failure is not surfaced clearly.
- [ ] The packaged tool cannot be installed or updated from the private feed.
- [ ] The smoke matrix has not been run against at least one real repo.

## Sign-off

- [ ] Release reviewed by the maintainer.
- [ ] Release reviewed by at least one additional developer.
- [ ] Release published to the private feed.
