import crypto from "node:crypto";
import path from "node:path";

import { loadConfig } from "./config.js";
import {
  assertGitRepository,
  baseBranchExists,
  getBranchPushStatus,
  getCurrentBranch,
  getPreferredRemote,
  getRemoteUrl,
  isWorkingTreeDirty,
  listChangedFiles,
  resolveGitRoot
} from "./git.js";
import { StateStore } from "./state-store.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { CodexAdapter } from "./codex-adapter.js";
import {
  type BranchReadiness,
  type FailureCategory,
  STATE_SCHEMA_VERSION,
  type ExecutionResult,
  type FelixConfig,
  type JobEvent,
  type IssueRunSummary,
  type JobStartRequest,
  type JobState,
  type PlanResult,
  type PlannedWorkItem,
  type RemoteBranchState,
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
  analyzeMergeReadiness?: (job: JobState) => Promise<JobState["mergeReadiness"]>;
  analyzeRemoteBranches?: (job: JobState) => Promise<JobState["remoteBranches"]>;
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
    issueRefs: item.issueRefs ?? [],
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

  if (job.workItems.some((item) => item.status === "boundary" || item.status === "blocked")) {
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

    if ((item.status === "boundary" || item.status === "blocked") && !includeBoundary) {
      return false;
    }

    return item.dependsOn.every((dependency) =>
      job.workItems.some((candidate) => candidate.id === dependency && candidate.status === "completed")
    );
  });
}

function blockedItems(job: JobState, includeBoundary: boolean): WorkItemState[] {
  const eligibleIds = new Set(eligibleItems(job, includeBoundary).map((item) => item.id));
  return job.workItems.filter((item) => {
    if (item.status === "completed" || item.status === "running" || item.status === "failed") {
      return false;
    }
    if (eligibleIds.has(item.id)) {
      return false;
    }
    return true;
  });
}

function recalculateMergeReadiness(workItems: WorkItemState[]): JobState["mergeReadiness"] {
  return {
    completedBranches: workItems.filter((item) => item.status === "completed" && item.branchName).map((item) => item.branchName as string),
    pendingBranches: workItems.filter((item) => item.status !== "completed" && item.branchName).map((item) => item.branchName as string),
    branchReadiness: [],
    generatedAt: undefined
  };
}

function deriveIssueRunStatus(items: WorkItemState[]): IssueRunSummary["status"] {
  if (items.some((item) => item.status === "failed" || item.status === "boundary" || item.status === "blocked")) {
    return "blocked";
  }
  if (items.every((item) => item.status === "completed")) {
    return "completed";
  }
  if (items.some((item) => item.status === "running" || item.status === "completed")) {
    return "in_progress";
  }
  return "not_started";
}

function buildIssueSummaries(job: JobState): IssueRunSummary[] {
  const byIssue = new Map<string, WorkItemState[]>();
  for (const item of job.workItems) {
    for (const issueRef of item.issueRefs ?? []) {
      const items = byIssue.get(issueRef) ?? [];
      items.push(item);
      byIssue.set(issueRef, items);
    }
  }

  return [...byIssue.entries()]
    .map(([issueRef, items]) => {
      const remoteBranches = job.remoteBranches.filter((branch) => items.some((item) => item.id === branch.workItemId));
      const latestItem = [...items]
        .filter((item) => item.lastResponse)
        .sort((left, right) => (right.completedAt ?? right.startedAt ?? "").localeCompare(left.completedAt ?? left.startedAt ?? ""));

      return {
        issueRef,
        status: deriveIssueRunStatus(items),
        workItemIds: items.map((item) => item.id),
        completedWorkItemIds: items.filter((item) => item.status === "completed").map((item) => item.id),
        pendingWorkItemIds: items.filter((item) => item.status === "pending" || item.status === "running").map((item) => item.id),
        failedWorkItemIds: items.filter((item) => item.status === "failed" || item.status === "boundary" || item.status === "blocked").map((item) => item.id),
        branchNames: items.map((item) => item.branchName).filter((value): value is string => Boolean(value)),
        remoteBranches: remoteBranches.map((branch) => branch.remoteBranchName ?? `${branch.remoteName ?? "local"}/${branch.branchName}`),
        latestResponse: latestItem[0]?.lastResponse,
        updatedAt: job.updatedAt
      } satisfies IssueRunSummary;
    })
    .sort((left, right) => left.issueRef.localeCompare(right.issueRef));
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

function classifyFailure(message: string): {
  category: FailureCategory;
  retryable: boolean;
  manualReviewRequired: boolean;
} {
  const normalized = message.toLowerCase();
  if (normalized.includes("workspace conflict")) {
    return { category: "workspace-conflict", retryable: false, manualReviewRequired: true };
  }
  if (normalized.includes("worktree") || normalized.includes("branch") || normalized.includes("git")) {
    return { category: "git", retryable: true, manualReviewRequired: true };
  }
  if (normalized.includes("workspace")) {
    return { category: "workspace-setup", retryable: true, manualReviewRequired: true };
  }
  return { category: "execution-error", retryable: true, manualReviewRequired: true };
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
    analyzeMergeReadiness:
      overrides?.analyzeMergeReadiness ??
      (async (job) => {
        const completed = job.workItems.filter((item) => item.status === "completed" && item.branchName);
        const branchReadiness: BranchReadiness[] = [];

        for (const item of completed) {
          const changedFiles = await listChangedFiles(job.repoRoot, job.baseBranch, item.branchName as string);
          branchReadiness.push({
            workItemId: item.id,
            branchName: item.branchName as string,
            changedFiles,
            conflictWith: []
          });
        }

        for (const branch of branchReadiness) {
          branch.conflictWith = branchReadiness
            .filter((candidate) => candidate.branchName !== branch.branchName)
            .filter((candidate) => candidate.changedFiles.some((file) => branch.changedFiles.includes(file)))
            .map((candidate) => candidate.branchName);
        }

        return {
          completedBranches: completed.map((item) => item.branchName as string),
          pendingBranches: job.workItems.filter((item) => item.status !== "completed" && item.branchName).map((item) => item.branchName as string),
          branchReadiness,
          generatedAt: now()
        };
      }),
    analyzeRemoteBranches:
      overrides?.analyzeRemoteBranches ??
      (async (job) => {
        const remoteName = await getPreferredRemote(job.repoRoot);
        const remoteUrl = remoteName ? await getRemoteUrl(job.repoRoot, remoteName) : undefined;
        const remoteBranches: RemoteBranchState[] = [];

        for (const item of job.workItems) {
          if (!item.branchName) {
            continue;
          }

          try {
            const pushState = await getBranchPushStatus(job.repoRoot, item.branchName, remoteName);
            remoteBranches.push({
              workItemId: item.id,
              branchName: item.branchName,
              issueRefs: item.issueRefs ?? [],
              remoteName,
              remoteUrl,
              remoteBranchName: pushState.remoteBranchName,
              existsRemotely: pushState.existsRemotely,
              pushStatus: pushState.pushStatus,
              aheadBy: pushState.aheadBy,
              behindBy: pushState.behindBy,
              checkedAt: now()
            });
          } catch {
            remoteBranches.push({
              workItemId: item.id,
              branchName: item.branchName,
              issueRefs: item.issueRefs ?? [],
              remoteName,
              remoteUrl,
              remoteBranchName: remoteName ? `${remoteName}/${item.branchName}` : undefined,
              existsRemotely: false,
              pushStatus: remoteName ? "unknown" : "no-remote",
              aheadBy: 0,
              behindBy: 0,
              checkedAt: now()
            });
          }
        }

        return remoteBranches;
      }),
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
      issueRefs: request.issueRefs ?? [],
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
        pendingBranches: [],
        branchReadiness: []
      },
      remoteBranches: [],
      issueSummaries: [],
      createdAt,
      updatedAt: createdAt
    };

    job = addEvent(job, "info", "job", `Created job for repo ${repoRoot}`);
    if (dirtyWorkingTree) {
      job = addEvent(job, "warn", "job", "Repository has uncommitted changes; proceeding because dirty working trees are allowed.");
    }
    await this.deps.store.saveJob(job);

    const plan = validatePlanResult(await this.deps.planner(request.task, repoRoot, baseBranch));
    await this.deps.store.savePlan(job.jobId, {
      jobId: job.jobId,
      repoRoot,
      baseBranch,
      task: request.task,
      issueRefs: request.issueRefs ?? [],
      createdAt: now(),
      plan
    });
    if (plan.workItems.length === 0) {
      throw new Error("Planner returned no work items.");
    }

    job = {
      ...job,
      status: "ready",
      planningSummary: plan.summary,
      updatedAt: now(),
      workItems: plan.workItems.map((item) =>
        workItemFromPlan({
          ...item,
          issueRefs: item.issueRefs && item.issueRefs.length > 0 ? item.issueRefs : request.issueRefs ?? []
        })
      )
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
    const inFlight = new Map<string, Promise<void>>();

    while (true) {
      const ready = eligibleItems(job, includeBoundary).filter((item) => !inFlight.has(item.id));
      const blocked = blockedItems(job, includeBoundary);
      while (ready.length > 0 && inFlight.size < job.parallelism) {
        const item = ready.shift();
        if (!item) {
          break;
        }
        const task = this.executeSingleItem(jobId, item.id).then(() => {
          inFlight.delete(item.id);
        });
        inFlight.set(item.id, task);
      }

      if (inFlight.size === 0) {
        job = await this.refreshDerivedState(job);
        if (job.mergeReadiness.branchReadiness.some((entry) => entry.conflictWith.length > 0)) {
          job = addEvent(job, "warn", "job", "Merge readiness detected overlapping branch file changes that may conflict.");
        }
        if (blocked.length > 0) {
          job = addEvent(
            job,
            "info",
            "job",
            `No runnable work items yet. Waiting on dependencies for: ${blocked.map((item) => item.id).join(", ")}`
          );
        }
        job.status = deriveJobStatus(job);
        await this.deps.store.saveJob(job);
        return job;
      }

      job = await this.deps.store.loadJob(jobId);
      const activeIds = [...inFlight.keys()];
      job = addEvent(job, "info", "job", `Scheduler in-flight=${activeIds.length} active=${activeIds.join(", ")}`);
      job.status = "running";
      await this.deps.store.saveJob(job);

      await Promise.race(inFlight.values());
      job = await this.deps.store.loadJob(jobId);
      includeBoundary = job.autoResume;
    }
  }

  private async getMergeReadiness(job: JobState): Promise<JobState["mergeReadiness"]> {
    if (this.deps.analyzeMergeReadiness) {
      return this.deps.analyzeMergeReadiness(job);
    }

    const completed = job.workItems.filter((item) => item.status === "completed" && item.branchName);
    const branchReadiness: BranchReadiness[] = [];

    for (const item of completed) {
      let changedFiles: string[] = [];
      try {
        changedFiles = await listChangedFiles(job.repoRoot, job.baseBranch, item.branchName as string);
      } catch {
        changedFiles = [];
      }
      branchReadiness.push({
        workItemId: item.id,
        branchName: item.branchName as string,
        changedFiles,
        conflictWith: []
      });
    }

    for (const branch of branchReadiness) {
      branch.conflictWith = branchReadiness
        .filter((candidate) => candidate.branchName !== branch.branchName)
        .filter((candidate) => candidate.changedFiles.some((file) => branch.changedFiles.includes(file)))
        .map((candidate) => candidate.branchName);
    }

    return {
      completedBranches: completed.map((item) => item.branchName as string),
      pendingBranches: job.workItems.filter((item) => item.status !== "completed" && item.branchName).map((item) => item.branchName as string),
      branchReadiness,
      generatedAt: now()
    };
  }

  private async getRemoteBranches(job: JobState): Promise<JobState["remoteBranches"]> {
    if (this.deps.analyzeRemoteBranches) {
      return this.deps.analyzeRemoteBranches(job);
    }

    return [];
  }

  private async refreshDerivedState(job: JobState): Promise<JobState> {
    job.mergeReadiness = await this.getMergeReadiness(job);
    job.remoteBranches = await this.getRemoteBranches(job);
    job.issueSummaries = buildIssueSummaries(job);
    return job;
  }

  private async executeSingleItem(jobId: string, workItemId: string): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    const item = job.workItems.find((entry) => entry.id === workItemId);
    if (!item) {
      throw new Error(`Unknown work item '${workItemId}'.`);
    }

    let workspace;
    try {
      workspace = await this.deps.workspaceManager.ensureWorkspace(
        job.jobId,
        item.id,
        job.baseBranch,
        job.repoRoot,
        item.issueRefs ?? []
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = classifyFailure(message);
      const failedItem: WorkItemState = {
        ...item,
        status: "failed",
        error: message,
        failureCategory: failure.category,
        retryable: failure.retryable,
        manualReviewRequired: failure.manualReviewRequired
      };
      job = await this.deps.store.loadJob(jobId);
      job = updateWorkItem(job, failedItem);
      job = await this.refreshDerivedState(job);
      job = addEvent(job, "error", "workspace", `Workspace setup failed [${failure.category}]: ${message}`, item.id);
      job = updateSession(job, {
        workItemId: item.id,
        status: "failed",
        attemptCount: item.attempts + 1,
        updatedAt: now(),
        error: message,
        failureCategory: failure.category,
        retryable: failure.retryable,
        manualReviewRequired: failure.manualReviewRequired
      });
      job.status = deriveJobStatus(job);
      await this.deps.store.saveJob(job);
      return job;
    }
    let updatedItem: WorkItemState = {
      ...item,
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      status: "running",
      attempts: item.attempts + 1,
      failureCategory: undefined,
      retryable: undefined,
      manualReviewRequired: undefined,
      startedAt: item.startedAt ?? now()
    };
    job = updateWorkItem(job, updatedItem);
    job = addEvent(
      job,
      "info",
      "workspace",
      `Prepared ${workspace.workspacePath} on ${workspace.branchName}${workspace.mode ? ` (${workspace.mode})` : ""}`,
      item.id
    );
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
          updatedItem.failureCategory = undefined;
          updatedItem.retryable = undefined;
          updatedItem.manualReviewRequired = undefined;
          job = updateWorkItem(job, updatedItem);
          job = await this.refreshDerivedState(job);
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
          updatedItem.failureCategory = "execution-boundary";
          updatedItem.retryable = true;
          updatedItem.manualReviewRequired = false;
          job = updateWorkItem(job, updatedItem);
          job = await this.refreshDerivedState(job);
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

        if (result.status === "blocked") {
          updatedItem.status = "blocked";
          updatedItem.error = result.summary;
          updatedItem.failureCategory = "execution-blocked";
          updatedItem.retryable = true;
          updatedItem.manualReviewRequired = true;
          job = updateWorkItem(job, updatedItem);
          job = await this.refreshDerivedState(job);
          job = addEvent(job, "warn", "session", "Execution blocked; manual review required before retry.", item.id);
          job = updateSession(job, {
            workItemId: item.id,
            sessionId,
            status: "blocked",
            workspacePath: workspace.workspacePath,
            branchName: workspace.branchName,
            attemptCount: updatedItem.attempts,
            lastPrompt: resumePrompt ?? item.prompt,
            lastResponse: result.summary,
            updatedAt: now(),
            error: result.summary,
            failureCategory: "execution-blocked",
            retryable: true,
            manualReviewRequired: true
          });
          job.status = deriveJobStatus(job);
          await this.deps.store.saveJob(job);
          return job;
        }

        updatedItem.status = "boundary";
        updatedItem.failureCategory = "execution-boundary";
        updatedItem.retryable = true;
        updatedItem.manualReviewRequired = true;
        job = updateWorkItem(job, updatedItem);
        job = await this.refreshDerivedState(job);
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
          updatedAt: now(),
          failureCategory: "execution-boundary",
          retryable: true,
          manualReviewRequired: true
        });
        job.status = deriveJobStatus(job);
        await this.deps.store.saveJob(job);
        return job;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = classifyFailure(message);
        updatedItem.status = "failed";
        updatedItem.error = message;
        updatedItem.sessionId = sessionId;
        updatedItem.failureCategory = failure.category;
        updatedItem.retryable = failure.retryable;
        updatedItem.manualReviewRequired = failure.manualReviewRequired;
        job = await this.deps.store.loadJob(jobId);
        job = updateWorkItem(job, updatedItem);
        job = await this.refreshDerivedState(job);
        job = addEvent(job, "error", "session", `Work item failed [${failure.category}]: ${message}`, item.id);
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
          error: message,
          failureCategory: failure.category,
          retryable: failure.retryable,
          manualReviewRequired: failure.manualReviewRequired
        });
        job.status = deriveJobStatus(job);
        await this.deps.store.saveJob(job);
        return job;
      }
    }
  }
}
