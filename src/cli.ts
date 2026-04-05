#!/usr/bin/env node

import path from "node:path";

import { readJsonFile } from "./fs-utils.js";
import { initializeProject } from "./init.js";
import { createJobManager } from "./job-manager.js";
import { readTaskFromJson } from "./validation.js";

function printUsage(): void {
  console.log(`FelixAI Orchestrator

Usage:
  felixai init [--force]
  felixai job start --repo <path> (--task "<large task>" | --task-file <file>) [--base-branch <branch>] [--parallel <n>] [--auto-resume]
  felixai job status <job-id>
  felixai job resume <job-id>
  felixai job list

Examples:
  felixai init
  felixai job start --repo . --task "Build the next milestone"
  felixai job start --repo . --task-file ./felixai.task.json --parallel 3 --auto-resume
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
          const job = await manager.startJob({
            repoPath,
            task,
            baseBranch,
            parallelism,
            autoResume
          });
          console.log(`[felixai] job ${job.jobId} status: ${job.status}`);
          console.log(`[felixai] planner summary: ${job.planningSummary ?? "n/a"}`);
          return;
        }
        case "status": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const job = await manager.getJob(jobId);
          console.log(`[felixai] job ${job.jobId}`);
          console.log(`[felixai] status: ${job.status}`);
          console.log(`[felixai] repo: ${job.repoRoot}`);
          console.log(`[felixai] base branch: ${job.baseBranch}`);
          console.log(`[felixai] planning summary: ${job.planningSummary ?? "n/a"}`);
          for (const item of job.workItems) {
            console.log(`[felixai] ${item.id}: ${item.status} (${item.branchName ?? "branch-pending"})`);
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
          for (const job of jobs) {
            console.log(`${job.jobId}  ${job.status}  ${job.baseBranch}  ${job.task}`);
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
