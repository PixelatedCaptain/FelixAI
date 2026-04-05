#!/usr/bin/env node

import path from "node:path";

import { readJsonFile } from "./fs-utils.js";
import packageJson from "../package.json" with { type: "json" };
import { loadConfig } from "./config.js";
import { initializeProject } from "./init.js";
import { createJobManager } from "./job-manager.js";
import type { JobState } from "./types.js";
import { readTaskFromJson } from "./validation.js";

function printUsage(): void {
  console.log(`FelixAI Orchestrator

Usage:
  felixai init [--force]
  felixai config show
  felixai version
  felixai job start --repo <path> (--task "<large task>" | --task-file <file>) [--base-branch <branch>] [--parallel <n>] [--auto-resume] [--require-clean] [--issue <id>]
  felixai job status <job-id> [--json]
  felixai job resume <job-id>
  felixai job list [--json]

Examples:
  felixai init
  felixai config show
  felixai job start --repo . --task "Build the next milestone"
  felixai job start --repo . --task-file ./felixai.task.json --parallel 3 --auto-resume
  felixai job start --repo . --task "Refactor auth" --require-clean
  felixai job start --repo . --task "Implement GH issue" --issue 142 --issue api-hardening
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
          if (job.remoteBranches.length > 0) {
            console.log("[felixai] remote branches:");
            for (const branch of job.remoteBranches) {
              const remoteName = branch.remoteBranchName ?? branch.remoteName ?? "local-only";
              console.log(
                `[felixai] remote ${branch.workItemId}: ${remoteName} status=${branch.pushStatus} ahead=${branch.aheadBy} behind=${branch.behindBy}`
              );
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
            ].join(" ");
            const issueInfo = item.issueRefs && item.issueRefs.length > 0 ? ` issues=${item.issueRefs.join(",")}` : "";
            const failureInfo = item.failureCategory ? ` failure=${item.failureCategory} retryable=${item.retryable ? "yes" : "no"}` : "";
            console.log(`[felixai] ${item.id}: ${item.status} ${details}${issueInfo}${failureInfo}`);
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
          throw new Error(`Unknown job subcommand '${jobCommand ?? ""}'. Use 'start', 'status', 'resume', or 'list'.`);
      }
    }
    default:
      printUsage();
      throw new Error(`Unknown command '${command}'.`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[felixai] ${message}`);
  process.exitCode = 1;
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
