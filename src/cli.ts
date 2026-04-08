#!/usr/bin/env node

import path from "node:path";

import { readJsonFile } from "./fs-utils.js";
import packageJson from "../package.json" with { type: "json" };
import { getCodexAuthStatus, loginWithCodex, logoutFromCodex } from "./auth.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { initializeProject } from "./init.js";
import { createJobManager } from "./job-manager.js";
import type { JobState } from "./types.js";
import { readTaskFromJson } from "./validation.js";

function printUsage(): void {
  console.log(`FelixAI Orchestrator

Usage:
  felixai auth login
  felixai auth status
  felixai auth logout
  felixai doctor
  felixai init [--force]
  felixai config show
  felixai version
  felixai job start --repo <path> (--task "<large task>" | --task-file <file>) [--base-branch <branch>] [--parallel <n>] [--auto-resume] [--require-clean] [--issue <id>]
  felixai job status <job-id> [--json]
  felixai job resume <job-id>
  felixai job push <job-id> [--work-item <id>] [--remote <name>]
  felixai job merge <job-id> [--work-item <id>] [--target-branch <branch>] [--json]
  felixai job pr <job-id> [--work-item <id>] [--base-branch <branch>] [--no-draft] [--json]
  felixai job resolve-conflicts <job-id> [--session <id>] [--json]
  felixai job list [--json]

Examples:
  felixai auth login
  felixai auth status
  felixai doctor
  felixai init
  felixai config show
  felixai job start --repo . --task "Build the next milestone"
  felixai job start --repo . --task-file ./felixai.task.json --parallel 3 --auto-resume
  felixai job start --repo . --task "Refactor auth" --require-clean
  felixai job start --repo . --task "Implement GH issue" --issue 142 --issue api-hardening
  felixai job push <job-id>
  felixai job merge <job-id> --target-branch main
  felixai job pr <job-id>
  felixai job resolve-conflicts <job-id>
`);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value '${value}'.`);
  }

  return parsed;
}

function getMultiFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        values.push(next);
      }
    }
  }
  return values;
}

function summarizeJob(job: JobState): {
  pending: number;
  running: number;
  boundary: number;
  blocked: number;
  completed: number;
  failed: number;
} {
  return job.workItems.reduce(
    (summary, item) => {
      summary[item.status] += 1;
      return summary;
    },
    {
      pending: 0,
      running: 0,
      boundary: 0,
      blocked: 0,
      completed: 0,
      failed: 0
    }
  );
}

function isBranchDriftError(message: string | undefined): boolean {
  return typeof message === "string" && /branch drift detected/i.test(message);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function findRepoInstructionsPath(job: JobState): string | undefined {
  const event = job.events.find((entry) => /Loaded repository instructions from /i.test(entry.message));
  if (!event) {
    return undefined;
  }

  return event.message.replace(/^.*Loaded repository instructions from /i, "").replace(/\.$/, "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || hasFlag(process.argv, "--help") || hasFlag(process.argv, "-h")) {
    printUsage();
    return;
  }

  const rest = args.slice(1);
  const force = hasFlag(rest, "--force");

  switch (command) {
    case "init": {
      const result = await initializeProject({ force });
      console.log("[felixai] initialized FelixAI Orchestrator project files");
      for (const entry of result.created) {
        console.log(`[felixai] created ${entry}`);
      }
      for (const entry of result.skipped) {
        console.log(`[felixai] skipped existing ${entry}`);
      }
      return;
    }
    case "auth": {
      const authCommand = rest[0];
      switch (authCommand) {
        case "login": {
          await loginWithCodex();
          const status = await getCodexAuthStatus();
          console.log(`[felixai] Codex login active: ${status.loggedIn ? "yes" : "no"}`);
          if (status.email) {
            console.log(`[felixai] account: ${status.email}`);
          }
          return;
        }
        case "status": {
          const status = await getCodexAuthStatus();
          console.log(`[felixai] Codex login active: ${status.loggedIn ? "yes" : "no"}`);
          if (status.email) {
            console.log(`[felixai] account: ${status.email}`);
          }
          if (status.userId) {
            console.log(`[felixai] user id: ${status.userId}`);
          }
          console.log(`[felixai] auth store: ${status.authFilePath}`);
          if (status.rawStatus) {
            console.log(`[felixai] codex status: ${status.rawStatus}`);
          }
          return;
        }
        case "logout": {
          await logoutFromCodex();
          console.log("[felixai] Codex login removed.");
          return;
        }
        default:
          throw new Error(`Unknown auth subcommand '${authCommand ?? ""}'. Use 'login', 'status', or 'logout'.`);
      }
    }
    case "doctor": {
      const report = await runDoctor(process.cwd());
      console.log(`[felixai] doctor status: ${report.overallStatus}`);
      for (const check of report.checks) {
        console.log(`[felixai] ${check.id}: ${check.status} ${check.summary}`);
        if (check.detail) {
          console.log(`[felixai] ${check.id} detail: ${check.detail}`);
        }
      }
      return;
    }
    case "config": {
      const configCommand = rest[0];
      if (configCommand !== "show") {
        throw new Error(`Unknown config subcommand '${configCommand ?? ""}'. Use 'show'.`);
      }

      const config = await loadConfig();
      console.log(`[felixai] credential source: ${config.credentialSource}`);
      console.log(`[felixai] state dir: ${config.stateDir}`);
      console.log(`[felixai] workspace root: ${config.workspaceRoot}`);
      console.log(`[felixai] log dir: ${config.logDir}`);
      console.log(`[felixai] sandbox mode: ${config.codex.sandboxMode}`);
      console.log(`[felixai] approval policy: ${config.codex.approvalPolicy}`);
      console.log(`[felixai] parallelism: ${config.codex.parallelism}`);
      console.log(`[felixai] auto resume: ${config.codex.autoResume}`);
      return;
    }
    case "version": {
      console.log(`[felixai] version: ${packageJson.version}`);
      console.log("[felixai] config schema version: 1");
      console.log("[felixai] state schema version: 1");
      return;
    }
    case "job": {
      const jobCommand = rest[0];
      const jobArgs = rest.slice(1);
      const manager = await createJobManager();

      switch (jobCommand) {
        case "start": {
          const repoPath = path.resolve(requireValue(getFlagValue(jobArgs, "--repo"), "Missing --repo value."));
          const task = await resolveTaskInput(jobArgs);
          const baseBranch = getFlagValue(jobArgs, "--base-branch");
          const parallelism = parseInteger(getFlagValue(jobArgs, "--parallel"));
          const autoResume = hasFlag(jobArgs, "--auto-resume");
          const requireClean = hasFlag(jobArgs, "--require-clean");
          const issueRefs = getMultiFlagValues(jobArgs, "--issue");
          const job = await manager.startJob({
            repoPath,
            task,
            baseBranch,
            parallelism,
            autoResume,
            requireClean,
            issueRefs
          });
          console.log(`[felixai] job ${job.jobId} status: ${job.status}`);
          console.log(`[felixai] planner summary: ${job.planningSummary ?? "n/a"}`);
          const repoInstructionsPath = findRepoInstructionsPath(job);
          if (repoInstructionsPath) {
            console.log(`[felixai] repo instructions: ${repoInstructionsPath}`);
          }
          if (job.issueRefs.length > 0) {
            console.log(`[felixai] issue refs: ${job.issueRefs.join(", ")}`);
          }
          return;
        }
        case "status": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const job = await manager.getJob(jobId);
          if (hasFlag(jobArgs, "--json")) {
            console.log(JSON.stringify(job, null, 2));
            return;
          }

          const summary = summarizeJob(job);
          console.log(`[felixai] job ${job.jobId}`);
          console.log(`[felixai] status: ${job.status}`);
          console.log(`[felixai] repo: ${job.repoRoot}`);
          console.log(`[felixai] base branch: ${job.baseBranch}`);
          if (job.issueRefs.length > 0) {
            console.log(`[felixai] issue refs: ${job.issueRefs.join(", ")}`);
          }
          console.log(`[felixai] planning summary: ${job.planningSummary ?? "n/a"}`);
          const repoInstructionsPath = findRepoInstructionsPath(job);
          if (repoInstructionsPath) {
            console.log(`[felixai] repo instructions: ${repoInstructionsPath}`);
          }
          console.log(
            `[felixai] work items: pending=${summary.pending} running=${summary.running} boundary=${summary.boundary} blocked=${summary.blocked} completed=${summary.completed} failed=${summary.failed}`
          );
          if (job.mergeReadiness.branchReadiness.length > 0) {
            console.log(
              `[felixai] merge readiness: completed=${job.mergeReadiness.completedBranches.length} pending=${job.mergeReadiness.pendingBranches.length}`
            );
            for (const branch of job.mergeReadiness.branchReadiness) {
              const conflicts = branch.conflictWith.length > 0 ? branch.conflictWith.join(",") : "none";
              console.log(
                `[felixai] merge ${branch.workItemId}: branch=${branch.branchName} files=${branch.changedFiles.length} conflicts=${conflicts}`
              );
            }
          }
          if (job.mergeAutomation.attemptedAt) {
            console.log(
              `[felixai] merge automation: status=${job.mergeAutomation.status} target=${job.mergeAutomation.targetBranch} merged=${job.mergeAutomation.mergedBranches.length} pending=${job.mergeAutomation.pendingBranches.length}`
            );
            if (job.mergeAutomation.mergeBranchName) {
              console.log(`[felixai] merge candidate branch: ${job.mergeAutomation.mergeBranchName}`);
            }
          }
          if (job.remoteBranches.length > 0) {
            console.log("[felixai] remote branches:");
            for (const branch of job.remoteBranches) {
              const remoteName = branch.remoteBranchName ?? branch.remoteName ?? "local-only";
              console.log(
                `[felixai] remote ${branch.workItemId}: ${remoteName} status=${branch.pushStatus} ahead=${branch.aheadBy} behind=${branch.behindBy}`
              );
            }
          }
          if (job.pullRequests.length > 0) {
            console.log("[felixai] pull requests:");
            for (const pullRequest of job.pullRequests) {
              console.log(
                `[felixai] pr ${pullRequest.workItemId}: status=${pullRequest.status} source=${pullRequest.sourceBranch} target=${pullRequest.targetBranch}`
              );
              if (pullRequest.error) {
                console.log(`[felixai] pr error: ${pullRequest.error}`);
              }
            }
          }
          if (job.issueSummaries.length > 0) {
            console.log("[felixai] issue summaries:");
            for (const summary of job.issueSummaries) {
              console.log(
                `[felixai] issue ${summary.issueRef}: ${summary.status} items=${summary.workItemIds.join(",")} branches=${summary.branchNames.join(",") || "none"}`
              );
            }
          }
          for (const item of job.workItems) {
            const session = job.sessions.find((entry) => entry.workItemId === item.id);
            const details = [
              `branch=${item.branchName ?? "branch-pending"}`,
              `session=${session?.sessionId ?? item.sessionId ?? "session-pending"}`,
              `attempts=${item.attempts}`
            ];
            if (item.status === "running") {
              const startedAt = parseIsoTimestamp(item.startedAt);
              if (startedAt !== undefined) {
                details.push(`running_for=${formatDuration(Date.now() - startedAt)}`);
              }
              const lastUpdate = parseIsoTimestamp(session?.updatedAt);
              if (lastUpdate !== undefined) {
                const sinceLastUpdate = Date.now() - lastUpdate;
                details.push(`last_signal=${formatDuration(sinceLastUpdate)}_ago`);
                details.push(`signal=${sinceLastUpdate >= 120_000 ? "stale" : "active"}`);
              }
            }
            const issueInfo = item.issueRefs && item.issueRefs.length > 0 ? ` issues=${item.issueRefs.join(",")}` : "";
            const failureInfo = item.failureCategory ? ` failure=${item.failureCategory} retryable=${item.retryable ? "yes" : "no"}` : "";
            console.log(`[felixai] ${item.id}: ${item.status} ${details.join(" ")}${issueInfo}${failureInfo}`);
          }
          const branchDriftItems = job.workItems.filter((item) => item.status === "failed" && isBranchDriftError(item.error));
          if (branchDriftItems.length > 0) {
            console.log("[felixai] action required: branch drift detected");
            for (const item of branchDriftItems) {
              console.log(
                `[felixai] branch drift ${item.id}: expected=${item.branchName ?? "unknown"} workspace=${item.workspacePath ?? "unknown"}`
              );
              console.log(`[felixai] branch drift detail: ${item.error}`);
            }
          }
          const staleRunningItems = job.workItems
            .map((item) => ({
              item,
              session: job.sessions.find((entry) => entry.workItemId === item.id)
            }))
            .filter(({ item, session }) => {
              if (item.status !== "running") {
                return false;
              }
              const updatedAt = parseIsoTimestamp(session?.updatedAt);
              return updatedAt !== undefined && Date.now() - updatedAt >= 120_000;
            });
          if (staleRunningItems.length > 0) {
            console.log("[felixai] action required: running work item may be stalled");
            for (const { item, session } of staleRunningItems) {
              const updatedAt = parseIsoTimestamp(session?.updatedAt) ?? Date.now();
              console.log(
                `[felixai] running ${item.id}: workspace=${item.workspacePath ?? "unknown"} last_signal=${formatDuration(Date.now() - updatedAt)}_ago`
              );
            }
          }
          const recentEvents = job.events.slice(-5);
          if (recentEvents.length > 0) {
            console.log("[felixai] recent events:");
            for (const event of recentEvents) {
              console.log(
                `[felixai] ${event.timestamp} ${event.level} ${event.scope}${event.workItemId ? `:${event.workItemId}` : ""} ${event.message}`
              );
            }
          }
          return;
        }
        case "resume": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const job = await manager.resumeJob(jobId);
          console.log(`[felixai] job ${job.jobId} status: ${job.status}`);
          return;
        }
        case "push": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const workItemIds = getMultiFlagValues(jobArgs.slice(1), "--work-item");
          const remoteName = getFlagValue(jobArgs.slice(1), "--remote");
          const job = await manager.pushJobBranches(jobId, {
            workItemIds: workItemIds.length > 0 ? workItemIds : undefined,
            remoteName
          });
          console.log(`[felixai] job ${job.jobId} pushed branches refreshed`);
          return;
        }
        case "merge": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const argsWithoutJobId = jobArgs.slice(1);
          const workItemIds = getMultiFlagValues(argsWithoutJobId, "--work-item");
          const targetBranch = getFlagValue(argsWithoutJobId, "--target-branch");
          const job = await manager.mergeJobBranches(jobId, {
            workItemIds: workItemIds.length > 0 ? workItemIds : undefined,
            targetBranch
          });
          if (hasFlag(argsWithoutJobId, "--json")) {
            console.log(JSON.stringify(job.mergeAutomation, null, 2));
            return;
          }
          console.log(`[felixai] merge status: ${job.mergeAutomation.status}`);
          console.log(`[felixai] merge target: ${job.mergeAutomation.targetBranch}`);
          if (job.mergeAutomation.mergeBranchName) {
            console.log(`[felixai] merge branch: ${job.mergeAutomation.mergeBranchName}`);
          }
          console.log(`[felixai] merged branches: ${job.mergeAutomation.mergedBranches.join(", ") || "none"}`);
          if (job.mergeAutomation.conflicts.length > 0) {
            for (const conflict of job.mergeAutomation.conflicts) {
              console.log(`[felixai] conflict ${conflict.sourceBranch}: ${conflict.files.join(", ") || "files unknown"}`);
            }
          }
          if (job.mergeAutomation.error) {
            console.log(`[felixai] merge error: ${job.mergeAutomation.error}`);
          }
          return;
        }
        case "pr": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const argsWithoutJobId = jobArgs.slice(1);
          const workItemIds = getMultiFlagValues(argsWithoutJobId, "--work-item");
          const baseBranch = getFlagValue(argsWithoutJobId, "--base-branch");
          const draft = !hasFlag(argsWithoutJobId, "--no-draft");
          const job = await manager.createJobPullRequests(jobId, {
            workItemIds: workItemIds.length > 0 ? workItemIds : undefined,
            baseBranch,
            draft
          });
          if (hasFlag(argsWithoutJobId, "--json")) {
            console.log(JSON.stringify(job.pullRequests, null, 2));
            return;
          }
          for (const pullRequest of job.pullRequests) {
            console.log(
              `[felixai] pr ${pullRequest.workItemId}: status=${pullRequest.status} source=${pullRequest.sourceBranch} target=${pullRequest.targetBranch}`
            );
            if (pullRequest.error) {
              console.log(`[felixai] pr error: ${pullRequest.error}`);
            }
            if (pullRequest.pullRequestUrl) {
              console.log(`[felixai] pr url: ${pullRequest.pullRequestUrl}`);
            } else if (pullRequest.compareUrl) {
              console.log(`[felixai] compare url: ${pullRequest.compareUrl}`);
            }
          }
          return;
        }
        case "resolve-conflicts": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const argsWithoutJobId = jobArgs.slice(1);
          const sessionId = getFlagValue(argsWithoutJobId, "--session");
          const job = await manager.resolveJobMergeConflicts(jobId, { sessionId });
          if (hasFlag(argsWithoutJobId, "--json")) {
            console.log(JSON.stringify(job.mergeAutomation, null, 2));
            return;
          }
          console.log(`[felixai] conflict resolution status: ${job.mergeAutomation.status}`);
          if (job.mergeAutomation.resolutionSessionId) {
            console.log(`[felixai] resolution session: ${job.mergeAutomation.resolutionSessionId}`);
          }
          if (job.mergeAutomation.resolutionSummary) {
            console.log(`[felixai] resolution summary: ${job.mergeAutomation.resolutionSummary}`);
          }
          if (job.mergeAutomation.conflicts.length > 0) {
            for (const conflict of job.mergeAutomation.conflicts) {
              console.log(`[felixai] remaining conflict ${conflict.sourceBranch}: ${conflict.files.join(", ") || "files unknown"}`);
            }
          }
          return;
        }
        case "list": {
          const jobs = await manager.listJobs();
          if (hasFlag(jobArgs, "--json")) {
            console.log(JSON.stringify(jobs, null, 2));
            return;
          }
          for (const job of jobs) {
            const summary = summarizeJob(job);
            console.log(
              `${job.jobId}  ${job.status}  branch=${job.baseBranch}  done=${summary.completed}/${job.workItems.length}  running=${summary.running}  failed=${summary.failed}  ${job.task}`
            );
          }
          return;
        }
        default:
          throw new Error(
            `Unknown job subcommand '${jobCommand ?? ""}'. Use 'start', 'status', 'resume', 'push', 'merge', 'pr', 'resolve-conflicts', or 'list'.`
          );
      }
    }
    default:
      printUsage();
      throw new Error(`Unknown command '${command}'.`);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[felixai] ${message}`);
    process.exit(1);
  });

async function resolveTaskInput(args: string[]): Promise<string> {
  const inlineTask = getFlagValue(args, "--task");
  const taskFile = getFlagValue(args, "--task-file");

  if (inlineTask && taskFile) {
    throw new Error("Use either --task or --task-file, not both.");
  }

  if (inlineTask) {
    return requireValue(inlineTask, "Missing --task value.");
  }

  if (taskFile) {
    const raw = await readJsonFile<unknown>(path.resolve(taskFile));
    return readTaskFromJson(raw);
  }

  throw new Error("Missing task input. Provide --task or --task-file.");
}
