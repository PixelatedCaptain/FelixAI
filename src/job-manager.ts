import crypto from "node:crypto";
import path from "node:path";

import { loadConfig } from "./config.js";
import { assertGitRepository, baseBranchExists, getCurrentBranch, isWorkingTreeDirty, resolveGitRoot } from "./git.js";
import { StateStore } from "./state-store.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { CodexAdapter } from "./codex-adapter.js";
import {
  STATE_SCHEMA_VERSION,
  type ExecutionResult,
  type FelixConfig,
  type JobEvent,
  type JobStartRequest,
  type JobState,
  type PlanResult,
  type PlannedWorkItem,
  type SessionState,
  type WorkItemState
} from "./types.js";
import { validatePlanResult } from "./validation.js";

export interface JobManagerDependencies {
  planner: (task: string, repoRoot: string, baseBranch: string) => Promise<PlanResult>;
  executor: (options: {
    prompt: string;
    workspacePath: string;
    sessionId?: string;
    resumePrompt?: string;
  }) => Promise<ExecutionResult>;
  workspaceManager: Pick<WorkspaceManager, "ensureWorkspace">;
  store: StateStore;
  config: FelixConfig;
  resolveRepoContext: (
    repoPath: string,
    requestedBaseBranch?: string,
    options?: { requireClean?: boolean }
  ) => Promise<{ repoRoot: string; baseBranch: string; dirtyWorkingTree: boolean }>;
}

function now(): string {
  return new Date().toISOString();
}

function createJobId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function workItemFromPlan(item: PlannedWorkItem): WorkItemState {
  return {
    ...item,
    status: "pending",
    attempts: 0
  };
}

function updateSession(job: JobState, session: SessionState): JobState {
  const sessions = job.sessions.filter((entry) => entry.workItemId !== session.workItemId);
  return {
    ...job,
    sessions: [...sessions, session]
  };
}

function addEvent(job: JobState, level: JobEvent["level"], scope: JobEvent["scope"], message: string, workItemId?: string): JobState {
  const timestamp = now();
  return {
    ...job,
    updatedAt: timestamp,
    events: [...job.events, { timestamp, level, scope, workItemId, message }]
  };
}

function deriveJobStatus(job: JobState): JobState["status"] {
  if (job.workItems.some((item) => item.status === "failed")) {
    return "failed";
  }

  if (job.workItems.every((item) => item.status === "completed")) {
    return "completed";
  }

  if (job.workItems.some((item) => item.status === "boundary")) {
    return "paused";
  }

  if (job.workItems.some((item) => item.status === "running")) {
    return "running";
  }

  return "ready";
}

function eligibleItems(job: JobState, includeBoundary: boolean): WorkItemState[] {
  return job.workItems.filter((item) => {
    if (item.status === "completed" || item.status === "running" || item.status === "failed") {
      return false;
    }

    if (item.status === "boundary" && !includeBoundary) {
      return false;
    }

    return item.dependsOn.every((dependency) =>
      job.workItems.some((candidate) => candidate.id === dependency && candidate.status === "completed")
    );
  });
}

function recalculateMergeReadiness(workItems: WorkItemState[]): JobState["mergeReadiness"] {
  return {
    completedBranches: workItems.filter((item) => item.status === "completed" && item.branchName).map((item) => item.branchName as string),
    pendingBranches: workItems.filter((item) => item.status !== "completed" && item.branchName).map((item) => item.branchName as string)
  };
}

function updateWorkItem(job: JobState, workItem: WorkItemState): JobState {
  const workItems = job.workItems.map((item) => (item.id === workItem.id ? workItem : item));
  return {
    ...job,
    updatedAt: now(),
    workItems,
    mergeReadiness: recalculateMergeReadiness(workItems)
  };
}

export async function createJobManager(projectRoot = process.cwd(), overrides?: Partial<JobManagerDependencies>): Promise<JobManager> {
  const config = overrides?.config ?? (await loadConfig(projectRoot));
  const store = overrides?.store ?? new StateStore(projectRoot, { stateDir: config.stateDir, logDir: config.logDir });
  const workspaceManager =
    overrides?.workspaceManager ?? new WorkspaceManager(path.resolve(projectRoot, config.workspaceRoot));
  const adapter = new CodexAdapter(config);

  return new JobManager({
    planner: overrides?.planner ?? ((task, repoRoot, baseBranch) => adapter.createPlan(task, repoRoot, baseBranch)),
    executor: overrides?.executor ?? ((options) => adapter.executeWorkItem(options)),
    workspaceManager,
    store,
    config,
    resolveRepoContext:
      overrides?.resolveRepoContext ??
      (async (repoPath, requestedBaseBranch, options) => {
        await assertGitRepository(repoPath);
        const repoRoot = await resolveGitRoot(repoPath);
        const baseBranch = requestedBaseBranch ?? config.defaultBaseBranch ?? (await getCurrentBranch(repoRoot));
        if (!(await baseBranchExists(repoRoot, baseBranch))) {
          throw new Error(`Base branch '${baseBranch}' does not exist in repository '${repoRoot}'.`);
        }

        const dirtyWorkingTree = await isWorkingTreeDirty(repoRoot);
        const requireClean = options?.requireClean ?? !config.git.allowDirtyWorkingTree;
        if (requireClean && dirtyWorkingTree) {
          throw new Error(`Repository '${repoRoot}' has uncommitted changes. Commit or stash them, or disable the clean-tree requirement.`);
        }

        return { repoRoot, baseBranch, dirtyWorkingTree };
      })
  });
}

export class JobManager {
  constructor(private readonly deps: JobManagerDependencies) {}

  async startJob(request: JobStartRequest): Promise<JobState> {
    const { repoRoot, baseBranch, dirtyWorkingTree } = await this.deps.resolveRepoContext(request.repoPath, request.baseBranch, {
      requireClean: request.requireClean
    });
    const createdAt = now();
    let job: JobState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      jobId: createJobId(),
      status: "planning",
      repoPath: path.resolve(request.repoPath),
      repoRoot,
      task: request.task,
      baseBranch,
      parallelism: request.parallelism ?? this.deps.config.codex.parallelism,
      autoResume: request.autoResume ?? this.deps.config.codex.autoResume,
      maxResumesPerItem: this.deps.config.codex.maxResumesPerItem,
      planningSummary: undefined,
      workItems: [],
      sessions: [],
      events: [],
      mergeReadiness: {
        completedBranches: [],
        pendingBranches: []
      },
      createdAt,
      updatedAt: createdAt
    };

    job = addEvent(job, "info", "job", `Created job for repo ${repoRoot}`);
    if (dirtyWorkingTree) {
      job = addEvent(job, "warn", "job", "Repository has uncommitted changes; proceeding because dirty working trees are allowed.");
    }
    await this.deps.store.saveJob(job);

    const plan = validatePlanResult(await this.deps.planner(request.task, repoRoot, baseBranch));
    if (plan.workItems.length === 0) {
      throw new Error("Planner returned no work items.");
    }

    job = {
      ...job,
      status: "ready",
      planningSummary: plan.summary,
      updatedAt: now(),
      workItems: plan.workItems.map(workItemFromPlan)
    };
    job = addEvent(job, "info", "planner", `Planner produced ${plan.workItems.length} work items.`);
    await this.deps.store.saveJob(job);

    return this.runJob(job.jobId);
  }

  async resumeJob(jobId: string): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    job = addEvent(job, "info", "job", "Manual resume requested.");
    job.status = "ready";
    await this.deps.store.saveJob(job);
    return this.runJob(jobId, true);
  }

  async getJob(jobId: string): Promise<JobState> {
    return this.deps.store.loadJob(jobId);
  }

  async listJobs(): Promise<JobState[]> {
    return this.deps.store.listJobs();
  }

  private async runJob(jobId: string, includeBoundary = false): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);

    while (true) {
      const ready = eligibleItems(job, includeBoundary).slice(0, job.parallelism);
      if (ready.length === 0) {
        job.status = deriveJobStatus(job);
        await this.deps.store.saveJob(job);
        return job;
      }

      job.status = "running";
      await this.deps.store.saveJob(job);

      await Promise.all(ready.map((item) => this.executeSingleItem(jobId, item.id)));
      job = await this.deps.store.loadJob(jobId);
      includeBoundary = job.autoResume;
    }
  }

  private async executeSingleItem(jobId: string, workItemId: string): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    const item = job.workItems.find((entry) => entry.id === workItemId);
    if (!item) {
      throw new Error(`Unknown work item '${workItemId}'.`);
    }

    const workspace = await this.deps.workspaceManager.ensureWorkspace(job.jobId, item.id, job.baseBranch, job.repoRoot);
    let updatedItem: WorkItemState = {
      ...item,
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      status: "running",
      attempts: item.attempts + 1,
      startedAt: item.startedAt ?? now()
    };
    job = updateWorkItem(job, updatedItem);
    job = addEvent(job, "info", "workspace", `Prepared ${workspace.workspacePath} on ${workspace.branchName}`, item.id);
    job = updateSession(job, {
      workItemId: item.id,
      sessionId: item.sessionId,
      status: "running",
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      attemptCount: updatedItem.attempts,
      lastPrompt: item.prompt,
      updatedAt: now()
    });
    await this.deps.store.saveJob(job);

    let resumePrompt: string | undefined;
    let sessionId = item.sessionId;

    while (true) {
      try {
        const result = await this.deps.executor({
          prompt: item.prompt,
          workspacePath: workspace.workspacePath,
          sessionId,
          resumePrompt
        });

        sessionId = result.sessionId ?? sessionId;
        updatedItem = {
          ...updatedItem,
          sessionId,
          lastResponse: result.summary
        };

        job = await this.deps.store.loadJob(jobId);

        if (result.status === "completed") {
          updatedItem.status = "completed";
          updatedItem.completedAt = now();
          job = updateWorkItem(job, updatedItem);
          job = addEvent(job, "info", "session", `Completed work item '${item.title}'.`, item.id);
          job = updateSession(job, {
            workItemId: item.id,
            sessionId,
            status: "completed",
            workspacePath: workspace.workspacePath,
            branchName: workspace.branchName,
            attemptCount: updatedItem.attempts,
            lastPrompt: resumePrompt ?? item.prompt,
            lastResponse: result.summary,
            updatedAt: now()
          });
          job.status = deriveJobStatus(job);
          await this.deps.store.saveJob(job);
          return job;
        }

        if (result.status === "needs_resume" && job.autoResume && updatedItem.attempts <= job.maxResumesPerItem) {
          resumePrompt = result.nextPrompt ?? "Continue the current work item from the current repo state.";
          updatedItem.attempts += 1;
          job = updateWorkItem(job, updatedItem);
          job = addEvent(job, "info", "session", "Boundary reached; auto-resuming work item.", item.id);
          job = updateSession(job, {
            workItemId: item.id,
            sessionId,
            status: "boundary",
            workspacePath: workspace.workspacePath,
            branchName: workspace.branchName,
            attemptCount: updatedItem.attempts,
            lastPrompt: resumePrompt,
            lastResponse: result.summary,
            updatedAt: now()
          });
          await this.deps.store.saveJob(job);
          continue;
        }

        updatedItem.status = "boundary";
        job = updateWorkItem(job, updatedItem);
        job = addEvent(job, "warn", "session", "Boundary reached; waiting for manual resume.", item.id);
        job = updateSession(job, {
          workItemId: item.id,
          sessionId,
          status: "boundary",
          workspacePath: workspace.workspacePath,
          branchName: workspace.branchName,
          attemptCount: updatedItem.attempts,
          lastPrompt: resumePrompt ?? item.prompt,
          lastResponse: result.summary,
          updatedAt: now()
        });
        job.status = deriveJobStatus(job);
        await this.deps.store.saveJob(job);
        return job;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updatedItem.status = "failed";
        updatedItem.error = message;
        updatedItem.sessionId = sessionId;
        job = await this.deps.store.loadJob(jobId);
        job = updateWorkItem(job, updatedItem);
        job = addEvent(job, "error", "session", `Work item failed: ${message}`, item.id);
        job = updateSession(job, {
          workItemId: item.id,
          sessionId,
          status: "failed",
          workspacePath: workspace.workspacePath,
          branchName: workspace.branchName,
          attemptCount: updatedItem.attempts,
          lastPrompt: resumePrompt ?? item.prompt,
          lastResponse: updatedItem.lastResponse,
          updatedAt: now(),
          error: message
        });
        job.status = deriveJobStatus(job);
        await this.deps.store.saveJob(job);
        return job;
      }
    }
  }
}
