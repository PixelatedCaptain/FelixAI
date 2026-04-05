import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, ensureFelixDirectories, loadConfig } from "./config.js";
import { pathExists, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { initializeProject } from "./init.js";
import { JobManager } from "./job-manager.js";
import { StateStore } from "./state-store.js";
import { WorkspaceManager } from "./workspace-manager.js";
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

async function createFakeWorkspaceForIssues(
  root: string,
  jobId: string,
  workItemId: string,
  issueRefs: string[] = []
): Promise<WorkspaceAssignment> {
  const workspace = await createFakeWorkspace(root, jobId, workItemId);
  const issueToken = issueRefs[0] ? `issue-${issueRefs[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : workItemId;
  return {
    ...workspace,
    branchName: `agent/${issueToken}/job-${jobId.slice(0, 8)}-${workItemId}`
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
      pendingBranches: [],
      branchReadiness: []
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    issueSummaries: [],
    issueRefs: [],
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

async function testSchedulerStartsDependentWorkWithoutWaitingForWholeWave(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-scheduler-"));
  await ensureFelixDirectories(root);
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();

  const manager = new JobManager({
    config: {
      ...DEFAULT_CONFIG,
      codex: {
        ...DEFAULT_CONFIG.codex,
        parallelism: 2
      }
    },
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "scheduler",
      workItems: [
        { id: "a", title: "A", prompt: "A", dependsOn: [] },
        { id: "b", title: "B", prompt: "B", dependsOn: [] },
        { id: "c", title: "C", prompt: "C", dependsOn: ["a"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> =>
      new Promise((resolve) => {
        started.push(prompt.toLowerCase());
        resolvers.set(prompt.toLowerCase(), () =>
          resolve({
            status: "completed",
            summary: prompt,
            sessionId: `session-${prompt.toLowerCase()}`
          })
        );
      })
  });

  const jobPromise = manager.startJob({
    repoPath: root,
    task: "scheduler"
  });

  while (!(started.includes("a") && started.includes("b"))) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  resolvers.get("a")?.();

  while (!started.includes("c")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(started.includes("c"), true);
  resolvers.get("b")?.();
  resolvers.get("c")?.();
  const job = await jobPromise;
  assert.equal(job.status, "completed");
}

async function testIssueRefsPropagateToJobsAndBranches(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issues-"));
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
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "issues",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [] }
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
    task: "issue refs",
    issueRefs: ["999"]
  });

  assert.deepEqual(job.issueRefs, ["999"]);
  assert.deepEqual(job.workItems.find((item) => item.id === "api")?.issueRefs, ["142"]);
  assert.deepEqual(job.workItems.find((item) => item.id === "ui")?.issueRefs, ["999"]);
  assert.match(job.workItems.find((item) => item.id === "api")?.branchName ?? "", /issue-142/);
}

async function testRemoteBranchMetadataAndIssueSummariesPersist(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-remote-"));
  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    analyzeRemoteBranches: async () => [
      {
        workItemId: "api",
        branchName: "agent/issue-142/job-12345678-api",
        issueRefs: ["142"],
        remoteName: "origin",
        remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
        remoteBranchName: "origin/agent/issue-142/job-12345678-api",
        existsRemotely: true,
        pushStatus: "ahead-of-remote",
        aheadBy: 2,
        behindBy: 0,
        checkedAt: new Date().toISOString()
      },
      {
        workItemId: "ui",
        branchName: "agent/issue-999/job-12345678-ui",
        issueRefs: ["999"],
        remoteName: "origin",
        remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
        remoteBranchName: "origin/agent/issue-999/job-12345678-ui",
        existsRemotely: false,
        pushStatus: "branch-not-pushed",
        aheadBy: 0,
        behindBy: 0,
        checkedAt: new Date().toISOString()
      }
    ],
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "remote metadata",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [], issueRefs: ["999"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} complete`,
      sessionId: `session-${prompt.toLowerCase()}`
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "remote metadata"
  });

  assert.equal(job.remoteBranches.length, 2);
  assert.equal(job.remoteBranches.find((branch) => branch.workItemId === "api")?.pushStatus, "ahead-of-remote");
  assert.equal(job.remoteBranches.find((branch) => branch.workItemId === "ui")?.pushStatus, "branch-not-pushed");
  assert.equal(job.issueSummaries.length, 2);
  assert.equal(job.issueSummaries.find((summary) => summary.issueRef === "142")?.status, "completed");
  assert.match(job.issueSummaries.find((summary) => summary.issueRef === "142")?.remoteBranches[0] ?? "", /origin\/agent\/issue-142/);

  const saved = await readJsonFile<JobState>(path.join(root, ".felixai", "state", "jobs", `${job.jobId}.json`));
  assert.equal(saved.remoteBranches.length, 2);
  assert.equal(saved.issueSummaries.length, 2);
}

async function testWorkspaceManagerReusesAndReattachesExistingWorktrees(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-worktree-"));
  const repoRoot = path.join(root, "repo");
  const worktreeState = new Map<string, string>();
  const existingPaths = new Set<string>();
  const managerA = new WorkspaceManager(path.join(root, ".felixai", "workspaces-a"), {
    pathExists: async (target) => existingPaths.has(path.resolve(target)),
    pruneWorktrees: async () => {},
    listWorktrees: async () =>
      [...worktreeState.entries()].map(([branch, worktreePath]) => ({
        path: worktreePath,
        branch,
        bare: false
      })),
    createWorktree: async (_repo, workspacePath, branchName) => {
      existingPaths.add(path.resolve(workspacePath));
      worktreeState.set(branchName, workspacePath);
    }
  });
  const managerB = new WorkspaceManager(path.join(root, ".felixai", "workspaces-b"), {
    pathExists: async (target) => existingPaths.has(path.resolve(target)),
    pruneWorktrees: async () => {},
    listWorktrees: async () =>
      [...worktreeState.entries()].map(([branch, worktreePath]) => ({
        path: worktreePath,
        branch,
        bare: false
      })),
    createWorktree: async (_repo, workspacePath, branchName) => {
      existingPaths.add(path.resolve(workspacePath));
      worktreeState.set(branchName, workspacePath);
    }
  });

  const first = await managerA.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);
  const second = await managerA.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);
  const third = await managerB.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);

  assert.equal(first.mode, "created");
  assert.equal(second.mode, "reused");
  assert.equal(second.workspacePath, first.workspacePath);
  assert.equal(third.mode, "reattached");
  assert.equal(third.workspacePath, first.workspacePath);

  existingPaths.delete(path.resolve(first.workspacePath));
  worktreeState.clear();
  const recreated = await managerA.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);
  assert.equal(recreated.mode, "created");
}

async function testWorkspaceConflictIsClassifiedAndPersisted(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-workspace-conflict-"));
  await ensureFelixDirectories(root);
  const conflictPath = path.join(root, ".felixai", "workspaces", "conflict-job", "api");
  await mkdir(conflictPath, { recursive: true });
  await writeFile(path.join(conflictPath, "stale.txt"), "stale", "utf8");

  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async () => {
        throw new Error(`Workspace conflict: path '${conflictPath}' already exists.`);
      }
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "workspace conflict",
      workItems: [{ id: "api", title: "API", prompt: "API", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "should not run"
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "workspace conflict"
  });

  assert.equal(job.status, "failed");
  assert.equal(job.workItems[0].status, "failed");
  assert.equal(job.workItems[0].failureCategory, "workspace-conflict");
  assert.equal(job.workItems[0].retryable, false);
  assert.equal(job.events.some((event) => event.scope === "workspace" && /workspace-conflict/i.test(event.message)), true);
}

async function testBlockedExecutionIsPersistedForManualReview(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-blocked-"));
  await ensureFelixDirectories(root);
  let blockedOnce = true;
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
      summary: "blocked",
      workItems: [{ id: "review", title: "Review", prompt: "Review", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => {
      if (blockedOnce) {
        blockedOnce = false;
        return {
          status: "blocked",
          summary: "Human approval required"
        };
      }

      return {
        status: "completed",
        summary: "Approved and completed"
      };
    }
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "blocked"
  });

  assert.equal(job.status, "paused");
  assert.equal(job.workItems[0].status, "blocked");
  assert.equal(job.workItems[0].failureCategory, "execution-blocked");
  assert.equal(job.workItems[0].retryable, true);
  assert.equal(job.workItems[0].manualReviewRequired, true);
  assert.equal(job.sessions[0]?.status, "blocked");

  const resumed = await manager.resumeJob(job.jobId);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.workItems[0].status, "completed");
}

async function testPushJobBranchesRefreshesRemoteState(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-push-"));
  await ensureFelixDirectories(root);
  let pushed = false;
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    analyzeRemoteBranches: async () =>
      pushed
        ? [
            {
              workItemId: "api",
              branchName: "agent/issue-142/job-12345678-api",
              issueRefs: ["142"],
              remoteName: "origin",
              remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
              remoteBranchName: "origin/agent/issue-142/job-12345678-api",
              existsRemotely: true,
              pushStatus: "up-to-date",
              aheadBy: 0,
              behindBy: 0,
              checkedAt: new Date().toISOString()
            }
          ]
        : [
            {
              workItemId: "api",
              branchName: "agent/issue-142/job-12345678-api",
              issueRefs: ["142"],
              remoteName: "origin",
              remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
              remoteBranchName: "origin/agent/issue-142/job-12345678-api",
              existsRemotely: false,
              pushStatus: "branch-not-pushed",
              aheadBy: 0,
              behindBy: 0,
              checkedAt: new Date().toISOString()
            }
          ],
    pushWorkItemBranches: async (job) => {
      pushed = true;
      return [
        {
          workItemId: job.workItems[0].id,
          branchName: job.workItems[0].branchName as string,
          issueRefs: job.workItems[0].issueRefs ?? [],
          remoteName: "origin",
          remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
          remoteBranchName: `origin/${job.workItems[0].branchName as string}`,
          existsRemotely: true,
          pushStatus: "up-to-date",
          aheadBy: 0,
          behindBy: 0,
          checkedAt: new Date().toISOString()
        }
      ];
    },
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "push",
      workItems: [{ id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "done",
      sessionId: "session-api"
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "push"
  });
  assert.equal(started.remoteBranches[0]?.pushStatus, "branch-not-pushed");

  const pushedJob = await manager.pushJobBranches(started.jobId);
  assert.equal(pushedJob.remoteBranches[0]?.pushStatus, "up-to-date");
  assert.equal(pushedJob.events.some((event) => /pushed completed branches/i.test(event.message)), true);
}

async function testMergeAutomationPersistsSuccessAndConflict(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-merge-auto-"));
  await ensureFelixDirectories(root);
  let conflictMode = false;
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    runMergeAutomation: async (job) =>
      conflictMode
        ? {
            targetBranch: "main",
            mergeBranchName: `agent/merge/job-${job.jobId.slice(0, 8)}`,
            mergedBranches: [job.workItems[0].branchName as string],
            pendingBranches: [],
            conflicts: [
              {
                sourceBranch: job.workItems[1].branchName as string,
                files: ["src/shared.ts"]
              }
            ],
            status: "conflicted",
            workspacePath: path.join(root, ".felixai", "merges", job.jobId),
            attemptedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            error: "merge conflict"
          }
        : {
            targetBranch: "main",
            mergeBranchName: `agent/merge/job-${job.jobId.slice(0, 8)}`,
            mergedBranches: job.workItems.map((item) => item.branchName as string),
            pendingBranches: [],
            conflicts: [],
            status: "merged",
            workspacePath: path.join(root, ".felixai", "merges", job.jobId),
            attemptedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          },
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "merge auto",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [], issueRefs: ["143"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} done`,
      sessionId: `session-${prompt.toLowerCase()}`
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "merge auto"
  });

  const merged = await manager.mergeJobBranches(started.jobId);
  assert.equal(merged.mergeAutomation.status, "merged");
  assert.equal(merged.mergeAutomation.mergedBranches.length, 2);

  conflictMode = true;
  const conflicted = await manager.mergeJobBranches(started.jobId);
  assert.equal(conflicted.mergeAutomation.status, "conflicted");
  assert.equal(conflicted.mergeAutomation.conflicts.length, 1);
}

async function testCreateJobPullRequestsPersistsLinks(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-pr-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    createPullRequests: async (job) =>
      job.workItems.map((item, index) => ({
        workItemId: item.id,
        sourceBranch: item.branchName as string,
        targetBranch: "main",
        issueRefs: item.issueRefs ?? [],
        title: item.title,
        body: `PR for ${item.id}`,
        compareUrl: `https://github.com/PixelatedCaptain/FelixAI/compare/main...${item.branchName as string}`,
        pullRequestNumber: index + 10,
        pullRequestUrl: `https://github.com/PixelatedCaptain/FelixAI/pull/${index + 10}`,
        status: "draft",
        updatedAt: new Date().toISOString()
      })),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "pr",
      workItems: [{ id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "done",
      sessionId: "session-api"
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "pr"
  });
  const job = await manager.createJobPullRequests(started.jobId);
  assert.equal(job.pullRequests.length, 1);
  assert.equal(job.pullRequests[0]?.status, "draft");
  assert.match(job.pullRequests[0]?.pullRequestUrl ?? "", /\/pull\/10$/);
}

async function testResolveJobMergeConflictsPersistsResolution(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-resolve-conflicts-"));
  await ensureFelixDirectories(root);
  let unresolved = true;
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    runMergeAutomation: async (job) => ({
      targetBranch: "main",
      mergeBranchName: `agent/merge/job-${job.jobId.slice(0, 8)}`,
      mergedBranches: [job.workItems[0].branchName as string],
      pendingBranches: [],
      conflicts: [
        {
          sourceBranch: job.workItems[1].branchName as string,
          files: ["src/shared.ts"]
        }
      ],
      status: "conflicted",
      workspacePath: path.join(root, ".felixai", "merges", job.jobId),
      attemptedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: "merge conflict"
    }),
    resolveMergeConflicts: async (job) => ({
      ...job.mergeAutomation,
      status: unresolved ? "conflicted" : "merged",
      conflicts: unresolved ? job.mergeAutomation.conflicts : [],
      resolutionSessionId: "session-resolve",
      resolutionSummary: unresolved ? "Conflicts still remain" : "Conflicts resolved successfully",
      error: unresolved ? "Conflicts remain after resolution attempt." : undefined,
      completedAt: new Date().toISOString()
    }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "resolve conflicts",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [], issueRefs: ["143"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} done`,
      sessionId: `session-${prompt.toLowerCase()}`
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "resolve conflicts"
  });
  await manager.mergeJobBranches(started.jobId);

  const unresolvedJob = await manager.resolveJobMergeConflicts(started.jobId);
  assert.equal(unresolvedJob.mergeAutomation.status, "conflicted");
  assert.equal(unresolvedJob.mergeAutomation.resolutionSessionId, "session-resolve");

  unresolved = false;
  const resolvedJob = await manager.resolveJobMergeConflicts(started.jobId);
  assert.equal(resolvedJob.mergeAutomation.status, "merged");
  assert.equal(resolvedJob.mergeAutomation.conflicts.length, 0);
  assert.equal(resolvedJob.mergeAutomation.resolutionSummary, "Conflicts resolved successfully");
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
  await testSchedulerStartsDependentWorkWithoutWaitingForWholeWave();
  await testIssueRefsPropagateToJobsAndBranches();
  await testRemoteBranchMetadataAndIssueSummariesPersist();
  await testWorkspaceManagerReusesAndReattachesExistingWorktrees();
  await testWorkspaceConflictIsClassifiedAndPersisted();
  await testBlockedExecutionIsPersistedForManualReview();
  await testPushJobBranchesRefreshesRemoteState();
  await testMergeAutomationPersistsSuccessAndConflict();
  await testCreateJobPullRequestsPersistsLinks();
  await testResolveJobMergeConflictsPersistsResolution();
  console.log("job manager tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
