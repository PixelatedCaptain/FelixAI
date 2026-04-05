import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, ensureFelixDirectories, loadConfig } from "./config.js";
import { pathExists, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { initializeProject } from "./init.js";
import { JobManager } from "./job-manager.js";
import { StateStore } from "./state-store.js";
import type { ExecutionResult, FelixConfig, JobState, PlanResult, WorkspaceAssignment } from "./types.js";

async function createFakeWorkspace(root: string, jobId: string, workItemId: string): Promise<WorkspaceAssignment> {
  const workspacePath = path.join(root, ".felixai", "workspaces", jobId, workItemId);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, "README.md"), `# ${workItemId}\n`, "utf8");
  return {
    workspacePath,
    branchName: `agent/${workItemId}/job-${jobId.slice(0, 8)}`
  };
}

async function testInit(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-init-"));
  const result = await initializeProject({ projectRoot: root });
  assert.ok(result.created.some((entry) => entry.endsWith(path.join(".felixai", "config.json"))));
  assert.ok(await pathExists(path.join(root, ".felixai", "state", "jobs")));
  assert.ok(await pathExists(path.join(root, ".felixai", "workspaces")));
}

async function testInvalidConfigFailsValidation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-config-"));
  await ensureFelixDirectories(root);
  await writeJsonFile(path.join(root, ".felixai", "config.json"), {
    schemaVersion: 1,
    stateDir: ".felixai/state",
    workspaceRoot: ".felixai/workspaces",
    logDir: ".felixai/logs",
    credentialSource: "not-valid",
    codex: DEFAULT_CONFIG.codex
  });

  await assert.rejects(loadConfig(root), /credentialSource/);
}

async function testPlannerAndExecutionFlow(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-job-"));
  await ensureFelixDirectories(root);

  const config: FelixConfig = {
    ...DEFAULT_CONFIG,
    workspaceRoot: ".felixai/workspaces",
    stateDir: ".felixai/state",
    logDir: ".felixai/logs",
    codex: {
      ...DEFAULT_CONFIG.codex,
      autoResume: false,
      parallelism: 2
    }
  };

  const store = new StateStore(root, { stateDir: config.stateDir, logDir: config.logDir });
  const manager = new JobManager({
    config,
    store,
    resolveRepoContext: async (repoPath, requestedBaseBranch) => ({
      repoRoot: repoPath,
      baseBranch: requestedBaseBranch ?? "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Two independent items",
      workItems: [
        { id: "plan-api", title: "Plan API", prompt: "Do api work", dependsOn: [] },
        { id: "plan-ui", title: "Plan UI", prompt: "Do ui work", dependsOn: [] }
      ]
    }),
    executor: async ({ prompt, workspacePath }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} at ${workspacePath}`,
      sessionId: `session-${path.basename(workspacePath)}`
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "Build the next milestone"
  });

  assert.equal(job.status, "completed");
  assert.equal(job.workItems.filter((item) => item.status === "completed").length, 2);
  assert.ok(job.workItems.every((item) => item.branchName?.startsWith("agent/")));
  assert.ok(await pathExists(job.workItems[0].workspacePath as string));
  assert.ok(await pathExists(path.join(root, ".felixai", "state", "plans", `${job.jobId}.plan.json`)));
  assert.ok(await pathExists(path.join(root, ".felixai", "logs", "jobs", `${job.jobId}.events.jsonl`)));
  assert.ok(await pathExists(path.join(root, ".felixai", "logs", "jobs", `${job.jobId}.summary.json`)));
}

async function testResumeFlow(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-resume-"));
  await ensureFelixDirectories(root);

  let firstAttempt = true;
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    resolveRepoContext: async (repoPath, requestedBaseBranch) => ({
      repoRoot: repoPath,
      baseBranch: requestedBaseBranch ?? "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Single item",
      workItems: [{ id: "resume-item", title: "Resume item", prompt: "Keep going", dependsOn: [] }]
    }),
    executor: async ({ sessionId }): Promise<ExecutionResult> => {
      if (firstAttempt) {
        firstAttempt = false;
        return {
          status: "needs_resume",
          summary: "Boundary reached",
          nextPrompt: "Continue the implementation",
          sessionId: sessionId ?? "resume-session"
        };
      }

      return {
        status: "completed",
        summary: "Finished after resume",
        sessionId: sessionId ?? "resume-session"
      };
    }
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "Do resume-sensitive work"
  });
  assert.equal(started.status, "paused");

  const resumed = await manager.resumeJob(started.jobId);
  assert.equal(resumed.status, "completed");

  const saved = await readJsonFile<JobState>(path.join(root, ".felixai", "state", "jobs", `${started.jobId}.json`));
  assert.equal(saved.status, "completed");
}

async function testInvalidStateFailsValidation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-state-"));
  await ensureFelixDirectories(root);
  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", "broken.json"), {
    schemaVersion: 1,
    jobId: "broken",
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "broken",
    baseBranch: "main",
    parallelism: 0,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: {
      completedBranches: [],
      pendingBranches: []
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  await assert.rejects(store.loadJob("broken"), /parallelism/);
}

async function testRequireCleanRejectsDirtyRepo(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-clean-"));
  await ensureFelixDirectories(root);

  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: true
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Should never plan",
      workItems: [{ id: "x", title: "x", prompt: "x", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "dirty repo allowed by override path"
  });
  assert.equal(job.events.some((event) => /uncommitted changes/i.test(event.message)), true);
}

async function testBaseBranchFailureBubblesClearly(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-branch-"));
  await ensureFelixDirectories(root);

  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => {
      throw new Error("Base branch 'missing-branch' does not exist in repository.");
    },
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Should never plan",
      workItems: [{ id: "x", title: "x", prompt: "x", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(
    manager.startJob({
      repoPath: root,
      task: "bad branch"
    }),
    /missing-branch/
  );
}

async function testDuplicatePlanIdsFail(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-plan-dup-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "duplicate ids",
      workItems: [
        { id: "dup", title: "one", prompt: "one", dependsOn: [] },
        { id: "dup", title: "two", prompt: "two", dependsOn: [] }
      ]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(manager.startJob({ repoPath: root, task: "dup ids" }), /duplicate work item id/i);
}

async function testMissingDependencyFails(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-plan-missing-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "missing dep",
      workItems: [{ id: "a", title: "A", prompt: "A", dependsOn: ["missing"] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(manager.startJob({ repoPath: root, task: "missing dep" }), /depends on missing work item/i);
}

async function testCircularDependencyFails(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-plan-cycle-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "cycle",
      workItems: [
        { id: "a", title: "A", prompt: "A", dependsOn: ["b"] },
        { id: "b", title: "B", prompt: "B", dependsOn: ["a"] }
      ]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(manager.startJob({ repoPath: root, task: "cycle" }), /circular dependency/i);
}

async function testMergeReadinessIsPersisted(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-merge-"));
  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    analyzeMergeReadiness: async (job) => ({
      completedBranches: ["agent/a/job-12345678", "agent/b/job-12345678"],
      pendingBranches: [],
      branchReadiness: [
        {
          workItemId: "a",
          branchName: "agent/a/job-12345678",
          changedFiles: ["src/shared.ts"],
          conflictWith: ["agent/b/job-12345678"]
        },
        {
          workItemId: "b",
          branchName: "agent/b/job-12345678",
          changedFiles: ["src/shared.ts", "src/feature.ts"],
          conflictWith: ["agent/a/job-12345678"]
        }
      ],
      generatedAt: new Date().toISOString()
    }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "merge readiness",
      workItems: [
        { id: "a", title: "A", prompt: "A", dependsOn: [] },
        { id: "b", title: "B", prompt: "B", dependsOn: [] }
      ]
    }),
    executor: async ({ workspacePath }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: workspacePath,
      sessionId: `session-${path.basename(workspacePath)}`
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "merge readiness"
  });

  assert.equal(job.mergeReadiness.branchReadiness.length, 2);
  assert.equal(job.mergeReadiness.branchReadiness[0].conflictWith.length > 0, true);
}

async function main(): Promise<void> {
  await testInit();
  await testInvalidConfigFailsValidation();
  await testPlannerAndExecutionFlow();
  await testResumeFlow();
  await testInvalidStateFailsValidation();
  await testRequireCleanRejectsDirtyRepo();
  await testBaseBranchFailureBubblesClearly();
  await testDuplicatePlanIdsFail();
  await testMissingDependencyFails();
  await testCircularDependencyFails();
  await testMergeReadinessIsPersisted();
  console.log("job manager tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
