import crypto from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import { loadConfig } from "./config.js";
import {
  assertGitRepository,
  baseBranchExists,
  checkoutBranch,
  commitAllChanges,
  continueMerge,
  createMergeWorktree,
  fileExistsInGitDir,
  getBranchPushStatus,
  getCurrentBranch,
  getPreferredRemote,
  getRemoteUrl,
  isMergeInProgress,
  isWorkingTreeDirty,
  listConflictedFiles,
  listChangedFiles,
  listWorkingTreeChanges,
  mergeBranchIntoCurrent,
  pushBranch,
  resolveGitRoot,
  stageAllChanges
} from "./git.js";
import { StateStore } from "./state-store.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { CodexAdapter } from "./codex-adapter.js";
import { buildCompareUrl, buildPullRequestFailureMessage, createPullRequest, getGitHubCliStatus } from "./github.js";
import { loadRepoAgentsPreferences } from "./repo-agents.js";
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
  type MergeAutomationState,
  type PlanResult,
  type PlannedWorkItem,
  type PullRequestLink,
  type RemoteBranchState,
  type SessionState,
  type WorkItemState
} from "./types.js";
import { refinePlanResult, validatePlanResult } from "./validation.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

export interface JobManagerDependencies {
  planner: (
    task: string,
    repoRoot: string,
    baseBranch: string,
    runtimePreferences?: { model?: string; modelReasoningEffort?: ModelReasoningEffort }
  ) => Promise<PlanResult>;
  executor: (options: {
    prompt: string;
    workspacePath: string;
    branchName?: string;
    sessionId?: string;
    resumePrompt?: string;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    onSessionReady?: (sessionId: string) => Promise<void> | void;
  }) => Promise<ExecutionResult>;
  workspaceManager: Pick<WorkspaceManager, "ensureWorkspace">;
  store: StateStore;
  config: FelixConfig;
  analyzeMergeReadiness?: (job: JobState) => Promise<JobState["mergeReadiness"]>;
  analyzeRemoteBranches?: (job: JobState) => Promise<JobState["remoteBranches"]>;
  pushWorkItemBranches?: (job: JobState, options?: { workItemIds?: string[]; remoteName?: string }) => Promise<JobState["remoteBranches"]>;
  runMergeAutomation?: (job: JobState, options?: { workItemIds?: string[]; targetBranch?: string }) => Promise<MergeAutomationState>;
  createPullRequests?: (
    job: JobState,
    options?: { workItemIds?: string[]; baseBranch?: string; draft?: boolean }
  ) => Promise<PullRequestLink[]>;
  resolveMergeConflicts?: (job: JobState, options?: { sessionId?: string }) => Promise<MergeAutomationState>;
  finalizeCompletedWorkItem?: (job: JobState, workItem: WorkItemState) => Promise<{ committed: boolean }>;
  executionHeartbeatMs?: number;
  staleRunningWarningMs?: number;
  progressReporter?: (message: string) => void;
  resolveRepoContext: (
    repoPath: string,
    requestedBaseBranch?: string,
    options?: { requireClean?: boolean }
  ) => Promise<{ repoRoot: string; baseBranch: string; dirtyWorkingTree: boolean }>;
}

function now(): string {
  return new Date().toISOString();
}

function isoToMillis(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function formatDurationFromMilliseconds(durationMs: number): string {
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

async function getLatestWorkspaceActivityAt(workspacePath: string, changedFiles: string[]): Promise<string | undefined> {
  let latest: number | undefined;
  for (const relativePath of changedFiles) {
    try {
      const fileStat = await stat(path.join(workspacePath, relativePath));
      const modified = fileStat.mtime.getTime();
      if (latest === undefined || modified > latest) {
        latest = modified;
      }
    } catch {
      // Best-effort only. Missing or deleted files should not break heartbeat persistence.
    }
  }

  return latest !== undefined ? new Date(latest).toISOString() : undefined;
}

async function collectWorkspaceProgress(workspacePath: string): Promise<{
  changedFilesCount: number;
  recentChangedFiles: string[];
  lastWorkspaceActivityAt?: string;
  progressSummary: string;
}> {
  const changedFiles = await listWorkingTreeChanges(workspacePath).catch(() => []);
  const lastWorkspaceActivityAt = await getLatestWorkspaceActivityAt(workspacePath, changedFiles);
  const recentChangedFiles = changedFiles.slice(0, 5);
  const summaryParts = [`changed_files=${changedFiles.length}`];
  if (recentChangedFiles.length > 0) {
    summaryParts.push(`recent=${recentChangedFiles.join(", ")}`);
  }
  if (lastWorkspaceActivityAt) {
    const ageMs = Math.max(0, Date.now() - Date.parse(lastWorkspaceActivityAt));
    summaryParts.push(`last_file_update=${formatDurationFromMilliseconds(ageMs)}_ago`);
  }

  return {
    changedFilesCount: changedFiles.length,
    recentChangedFiles,
    lastWorkspaceActivityAt,
    progressSummary: summaryParts.join(" ")
  };
}

async function canAutoStageConflictFile(workspacePath: string, relativePath: string): Promise<boolean> {
  try {
    const contents = await readFile(path.join(workspacePath, relativePath), "utf8");
    return !contents.includes("<<<<<<<") && !contents.includes("=======") && !contents.includes(">>>>>>>");
  } catch {
    return false;
  }
}

async function settleMergeResolution(repoPath: string, workspacePath: string): Promise<{ remaining: string[]; mergeInProgress: boolean }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const lockExists = await fileExistsInGitDir(repoPath, "index.lock");
    if (lockExists) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    const unresolvedFiles = await listConflictedFiles(workspacePath).catch(() => []);
    if (unresolvedFiles.length === 0) {
      const mergeInProgress = await isMergeInProgress(workspacePath).catch(() => false);
      if (!mergeInProgress) {
        return { remaining: [], mergeInProgress: false };
      }

      try {
        await continueMerge(workspacePath);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }

      const mergeStillInProgress = await isMergeInProgress(workspacePath).catch(() => false);
      if (!mergeStillInProgress) {
        return { remaining: [], mergeInProgress: false };
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    let allConflictsResolved = true;
    for (const file of unresolvedFiles) {
      if (!(await canAutoStageConflictFile(workspacePath, file))) {
        allConflictsResolved = false;
        break;
      }
    }

    if (!allConflictsResolved) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    try {
      await stageAllChanges(repoPath);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const remaining = await listConflictedFiles(workspacePath).catch(() => []);
  const mergeInProgress = remaining.length === 0 ? await isMergeInProgress(workspacePath).catch(() => false) : true;
  return { remaining, mergeInProgress };
}

function createJobId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function buildInstructionAwareTask(
  task: string,
  repoInstructions: { path: string; content: string } | undefined
): string {
  if (!repoInstructions) {
    return task;
  }

  return [
    `Repository instructions file: ${repoInstructions.path}`,
    "Read and follow that file during this planning session unless the user explicitly overrides it.",
    `Task: ${task}`
  ].join("\n");
}

function buildInstructionAwarePrompt(
  prompt: string,
  repoInstructions: { path: string; content: string } | undefined,
  branchName?: string
): string {
  const lines: string[] = [];
  if (repoInstructions) {
    lines.push(`Repository instructions file: ${repoInstructions.path}`);
    lines.push("Read and follow that file during this work item unless the user explicitly overrides it.");
  }
  if (branchName) {
    lines.push(`Dedicated branch for this work item: ${branchName}`);
    lines.push("Work only on that branch for this issue/session.");
  }
  lines.push(prompt);
  return lines.join("\n\n");
}

function jobToken(jobId: string): string {
  return jobId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "job";
}

function workItemFromPlan(item: PlannedWorkItem): WorkItemState {
  return {
    ...item,
    issueRefs: item.issueRefs ?? [],
    status: "pending",
    attempts: 0
  };
}

function createEmptyMergeAutomation(targetBranch: string): MergeAutomationState {
  return {
    targetBranch,
    mergedBranches: [],
    pendingBranches: [],
    conflicts: [],
    status: "pending"
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

function summarizeTaskForList(task: string, maxLength = 120): string {
  const firstMeaningfulLine =
    task
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (firstMeaningfulLine.length <= maxLength) {
    return firstMeaningfulLine;
  }
  return `${firstMeaningfulLine.slice(0, maxLength - 3)}...`;
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

async function tryGetCurrentBranch(repoPath: string): Promise<string | undefined> {
  try {
    return await getCurrentBranch(repoPath);
  } catch {
    return undefined;
  }
}

export async function createJobManager(projectRoot = process.cwd(), overrides?: Partial<JobManagerDependencies>): Promise<JobManager> {
  const config = overrides?.config ?? (await loadConfig(projectRoot));
  const store = overrides?.store ?? new StateStore(projectRoot, { stateDir: config.stateDir, logDir: config.logDir });
  const workspaceManager =
    overrides?.workspaceManager ?? new WorkspaceManager(path.resolve(projectRoot, config.workspaceRoot));
  const adapter = new CodexAdapter(config);

  return new JobManager({
    planner:
      overrides?.planner ??
      ((task, repoRoot, baseBranch, runtimePreferences) => adapter.createPlan(task, repoRoot, baseBranch, runtimePreferences)),
    executor: overrides?.executor ?? ((options) => adapter.executeWorkItem(options)),
    workspaceManager,
    store,
    config,
    progressReporter: overrides?.progressReporter ?? ((message) => console.log(message)),
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
      }),
    finalizeCompletedWorkItem:
      overrides?.finalizeCompletedWorkItem ??
      (async (_job, workItem) => {
        if (!workItem.workspacePath) {
          return { committed: false };
        }

        try {
          await assertGitRepository(workItem.workspacePath);
        } catch {
          return { committed: false };
        }

        return {
          committed: await commitAllChanges(
            workItem.workspacePath,
            `felixai: complete ${workItem.id} - ${workItem.title}`.slice(0, 72)
          )
        };
      })
  });
}

export class JobManager {
  constructor(private readonly deps: JobManagerDependencies) {}

  async archiveStaleActiveJobs(options?: { repoRoot?: string; staleAfterMs?: number }): Promise<JobState[]> {
    const staleAfterMs = options?.staleAfterMs ?? 15 * 60_000;
    const cutoff = Date.now() - staleAfterMs;
    const archived: JobState[] = [];
    const jobs = await this.deps.store.listJobs();

    for (const job of jobs) {
      if (options?.repoRoot && path.resolve(job.repoRoot) !== path.resolve(options.repoRoot)) {
        continue;
      }
      if (!["planning", "ready", "running"].includes(job.status)) {
        continue;
      }

      const updatedAtMs = isoToMillis(job.updatedAt) ?? 0;
      if (updatedAtMs > cutoff) {
        continue;
      }

      const archivedJob = addEvent(job, "warn", "job", `Archived stale active job after ${formatDurationFromMilliseconds(Date.now() - updatedAtMs)} without updates.`);
      await this.deps.store.saveJob(archivedJob);
      if (await this.deps.store.archiveJob(job.jobId)) {
        archived.push(archivedJob);
      }
    }

    return archived.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async startJob(request: JobStartRequest): Promise<JobState> {
    const { repoRoot, baseBranch, dirtyWorkingTree } = await this.deps.resolveRepoContext(request.repoPath, request.baseBranch, {
      requireClean: request.requireClean
    });
    const createdAt = now();
    let job: JobState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      jobId: createJobId(),
      shellSessionId: request.shellSessionId ?? process.env.FELIXAI_SHELL_SESSION_ID,
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
      mergeAutomation: createEmptyMergeAutomation(baseBranch),
      remoteBranches: [],
      pullRequests: [],
      issueSummaries: [],
      createdAt,
      updatedAt: createdAt
    };

    job = addEvent(job, "info", "job", `Created job for repo ${repoRoot}`);
    if (dirtyWorkingTree) {
      job = addEvent(job, "warn", "job", "Repository has uncommitted changes; proceeding because dirty working trees are allowed.");
    }
    const repoInstructions = await loadRepoAgentsPreferences(repoRoot);
    if (repoInstructions) {
      job = addEvent(job, "info", "job", `Loaded repository instructions from ${repoInstructions.path}.`);
    }
    await this.deps.store.saveJob(job);

    const validatedPlan = validatePlanResult(
      await this.deps.planner(buildInstructionAwareTask(request.task, repoInstructions), repoRoot, baseBranch, {
        model: repoInstructions?.model,
        modelReasoningEffort: repoInstructions?.reasoningEffort
      })
    );
    const plan = validatePlanResult(refinePlanResult(validatedPlan));
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

    if (plan.workItems.length !== validatedPlan.workItems.length) {
      job = addEvent(
        job,
        "info",
        "planner",
        `FelixAI collapsed ${validatedPlan.workItems.length - plan.workItems.length} coupled verification work item(s) before execution.`
      );
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

  private getExecutionHeartbeatMs(): number {
    return this.deps.executionHeartbeatMs ?? 10_000;
  }

  private getStaleRunningWarningMs(): number {
    return this.deps.staleRunningWarningMs ?? 120_000;
  }

  async listJobs(): Promise<JobState[]> {
    return this.deps.store.listJobs();
  }

  formatJobListSummary(job: JobState): string {
    return summarizeTaskForList(job.task);
  }

  async pushJobBranches(jobId: string, options?: { workItemIds?: string[]; remoteName?: string }): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    job.remoteBranches = this.deps.pushWorkItemBranches
      ? await this.deps.pushWorkItemBranches(job, options)
      : await this.pushBranchesDefault(job, options);
    job.issueSummaries = buildIssueSummaries(job);
    job = addEvent(job, "info", "job", "Pushed completed branches and refreshed remote branch state.");
    await this.deps.store.saveJob(job);
    return job;
  }

  async mergeJobBranches(jobId: string, options?: { workItemIds?: string[]; targetBranch?: string }): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    job.mergeAutomation = this.deps.runMergeAutomation
      ? await this.deps.runMergeAutomation(job, options)
      : await this.runMergeAutomationDefault(job, options);

    if (job.mergeAutomation.status === "merged") {
      job = addEvent(
        job,
        "info",
        "job",
        `Merge automation created '${job.mergeAutomation.mergeBranchName}' with ${job.mergeAutomation.mergedBranches.length} merged branch(es).`
      );
    } else if (job.mergeAutomation.status === "conflicted") {
      job = addEvent(
        job,
        "warn",
        "job",
        `Merge automation hit conflicts on ${job.mergeAutomation.conflicts.map((entry) => entry.sourceBranch).join(", ")}.`
      );
    } else {
      job = addEvent(job, "error", "job", `Merge automation failed: ${job.mergeAutomation.error ?? "unknown error"}`);
    }

    await this.deps.store.saveJob(job);
    return job;
  }

  async createJobPullRequests(jobId: string, options?: { workItemIds?: string[]; baseBranch?: string; draft?: boolean }): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    job.pullRequests = this.deps.createPullRequests
      ? await this.deps.createPullRequests(job, options)
      : await this.createPullRequestsDefault(job, options);
    job = addEvent(job, "info", "job", `Prepared ${job.pullRequests.length} pull request link(s).`);
    await this.deps.store.saveJob(job);
    return job;
  }

  async resolveJobMergeConflicts(jobId: string, options?: { sessionId?: string }): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    job.mergeAutomation = this.deps.resolveMergeConflicts
      ? await this.deps.resolveMergeConflicts(job, options)
      : await this.resolveMergeConflictsDefault(job, options);

    if (job.mergeAutomation.status === "merged") {
      job = addEvent(job, "info", "job", "Conflict resolution completed successfully on the merge candidate branch.");
    } else if (job.mergeAutomation.status === "conflicted") {
      job = addEvent(job, "warn", "job", "Conflict resolution ran but merge conflicts remain.");
    } else {
      job = addEvent(job, "error", "job", `Conflict resolution failed: ${job.mergeAutomation.error ?? "unknown error"}`);
    }

    await this.deps.store.saveJob(job);
    return job;
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

  private async pushBranchesDefault(job: JobState, options?: { workItemIds?: string[]; remoteName?: string }): Promise<JobState["remoteBranches"]> {
    const remoteName = options?.remoteName ?? (await getPreferredRemote(job.repoRoot));
    if (!remoteName) {
      throw new Error(`No Git remote is configured for repository '${job.repoRoot}'.`);
    }

    const selected = job.workItems.filter(
      (item) =>
        item.status === "completed" &&
        item.branchName &&
        (!options?.workItemIds || options.workItemIds.includes(item.id))
    );
    const pushable: WorkItemState[] = [];
    for (const item of selected) {
      const changedFiles = await listChangedFiles(job.repoRoot, job.baseBranch, item.branchName as string).catch(() => []);
      if (changedFiles.length > 0) {
        pushable.push(item);
      }
    }
    if (pushable.length === 0) {
      return this.getRemoteBranches(job);
    }

    for (const item of pushable) {
      await pushBranch(job.repoRoot, item.branchName as string, remoteName);
    }

    return this.getRemoteBranches(job);
  }

  private async runMergeAutomationDefault(job: JobState, options?: { workItemIds?: string[]; targetBranch?: string }): Promise<MergeAutomationState> {
    const targetBranch = options?.targetBranch ?? job.baseBranch;
    const mergeAutomation = createEmptyMergeAutomation(targetBranch);
    mergeAutomation.mergeBranchName = `agent/merge/job-${jobToken(job.jobId)}`;
    mergeAutomation.workspacePath = path.join(path.resolve(job.repoPath), ".felixai", "merges", job.jobId);
    mergeAutomation.attemptedAt = now();

    const selected = job.workItems.filter(
      (item) =>
        item.status === "completed" &&
        item.branchName &&
        (!options?.workItemIds || options.workItemIds.includes(item.id))
    );
    const mergeable: WorkItemState[] = [];
    for (const item of selected) {
      const changedFiles = await listChangedFiles(job.repoRoot, targetBranch, item.branchName as string).catch(() => []);
      if (changedFiles.length > 0) {
        mergeable.push(item);
      }
    }
    mergeAutomation.pendingBranches = mergeable.map((item) => item.branchName as string);

    if (mergeable.length === 0) {
      mergeAutomation.status = "failed";
      mergeAutomation.error = "No completed branches with changes are available to merge.";
      mergeAutomation.completedAt = now();
      return mergeAutomation;
    }

    try {
      await createMergeWorktree(job.repoRoot, mergeAutomation.workspacePath, mergeAutomation.mergeBranchName, targetBranch);
      for (const item of mergeable) {
        const branchName = item.branchName as string;
        try {
          await mergeBranchIntoCurrent(mergeAutomation.workspacePath, branchName);
          mergeAutomation.mergedBranches.push(branchName);
          mergeAutomation.pendingBranches = mergeAutomation.pendingBranches.filter((entry) => entry !== branchName);
        } catch (error) {
          mergeAutomation.conflicts.push({
            sourceBranch: branchName,
            files: await listConflictedFiles(mergeAutomation.workspacePath).catch(() => [])
          });
          mergeAutomation.pendingBranches = mergeAutomation.pendingBranches.filter((entry) => entry !== branchName);
          mergeAutomation.status = "conflicted";
          mergeAutomation.error = error instanceof Error ? error.message : String(error);
          mergeAutomation.completedAt = now();
          return mergeAutomation;
        }
      }

      mergeAutomation.status = "merged";
      mergeAutomation.completedAt = now();
      return mergeAutomation;
    } catch (error) {
      mergeAutomation.status = "failed";
      mergeAutomation.error = error instanceof Error ? error.message : String(error);
      mergeAutomation.completedAt = now();
      return mergeAutomation;
    }
  }

  private async createPullRequestsDefault(
    job: JobState,
    options?: { workItemIds?: string[]; baseBranch?: string; draft?: boolean }
  ): Promise<PullRequestLink[]> {
    const targetBranch = options?.baseBranch ?? job.baseBranch;
    const remoteName = await getPreferredRemote(job.repoRoot);
    const remoteUrl = remoteName ? await getRemoteUrl(job.repoRoot, remoteName) : undefined;
    const selected = job.workItems.filter(
      (item) =>
        item.status === "completed" &&
        item.branchName &&
        (!options?.workItemIds || options.workItemIds.includes(item.id))
    );

    const links: PullRequestLink[] = [];
    for (const item of selected) {
      const changedFiles = await listChangedFiles(job.repoRoot, targetBranch, item.branchName as string).catch(() => []);
      const issuePrefix = (item.issueRefs ?? []).map((issue) => `#${issue}`).join(" ");
      const title = `${item.title}${issuePrefix ? ` (${issuePrefix})` : ""}`;
      const bodyLines = [
        `Automated FelixAI pull request for work item \`${item.id}\`.`,
        "",
        `Source branch: \`${item.branchName as string}\``,
        `Target branch: \`${targetBranch}\``
      ];
      if ((item.issueRefs ?? []).length > 0) {
        bodyLines.push("", `Related issues: ${(item.issueRefs ?? []).map((issue) => `#${issue}`).join(", ")}`);
      }
      if (item.lastResponse) {
        bodyLines.push("", "Latest FelixAI summary:", item.lastResponse);
      }
      const body = bodyLines.join("\n");
      const compareUrl = remoteUrl ? buildCompareUrl(remoteUrl, targetBranch, item.branchName as string) : undefined;

      if (changedFiles.length === 0) {
        links.push({
          workItemId: item.id,
          sourceBranch: item.branchName as string,
          targetBranch,
          issueRefs: item.issueRefs ?? [],
          title,
          body,
          compareUrl,
          error: "No changes relative to the target branch; skipping pull request creation.",
          status: "not-created",
          updatedAt: now()
        });
        continue;
      }

      let created: { number?: number; url?: string; status: "draft" | "open" } | undefined;
      let pullRequestError: string | undefined;
      try {
        created = await createPullRequest({
          repoPath: job.repoRoot,
          baseBranch: targetBranch,
          headBranch: item.branchName as string,
          title,
          body,
          draft: options?.draft ?? true
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const ghAuthStatus = await getGitHubCliStatus(job.repoRoot);
        pullRequestError = buildPullRequestFailureMessage(message, ghAuthStatus);
        job = addEvent(job, "warn", "job", `Pull request creation failed for '${item.id}': ${message}`, item.id);
        created = undefined;
      }

      links.push({
        workItemId: item.id,
        sourceBranch: item.branchName as string,
        targetBranch,
        issueRefs: item.issueRefs ?? [],
        title,
        body,
        compareUrl,
        pullRequestNumber: created?.number,
        pullRequestUrl: created?.url,
        error: pullRequestError,
        status: created?.status ?? "not-created",
        updatedAt: now()
      });
    }

    return links;
  }

  private async resolveMergeConflictsDefault(job: JobState, options?: { sessionId?: string }): Promise<MergeAutomationState> {
    const current = { ...job.mergeAutomation };
    if (current.status !== "conflicted" || !current.workspacePath) {
      return {
        ...current,
        status: "failed",
        error: "No conflicted merge candidate is available to resolve."
      };
    }

    const conflictFiles = current.conflicts.flatMap((entry) => entry.files);
    const uniqueFiles = [...new Set(conflictFiles)];
    const prompt = [
      "Resolve the current Git merge conflicts in this workspace.",
      `Target branch: ${current.targetBranch}`,
      `Candidate branch: ${current.mergeBranchName ?? "unknown"}`,
      uniqueFiles.length > 0 ? `Conflicted files: ${uniqueFiles.join(", ")}` : "Conflicted files: unknown",
      "Inspect the repo state, resolve the conflicts, stage the resolved files if appropriate, and summarize the resolution."
    ].join("\n");

    const result = await this.deps.executor({
      prompt,
      workspacePath: current.workspacePath,
      sessionId: options?.sessionId
    });

    const settled = await settleMergeResolution(current.workspacePath, current.workspacePath);
    const remaining = settled.remaining;

    const mergeStillInProgress = await isMergeInProgress(current.workspacePath).catch(() => false);
    const resolved = remaining.length === 0 && !mergeStillInProgress;
    return {
      ...current,
      resolutionSessionId: result.sessionId ?? current.resolutionSessionId,
      resolutionSummary: result.summary,
      conflicts: resolved
        ? []
        : current.conflicts.map((entry) => ({
            ...entry,
            files: remaining
          })),
      status: resolved ? "merged" : "conflicted",
      completedAt: resolved ? now() : current.completedAt,
      error: resolved
        ? undefined
        : mergeStillInProgress
          ? "Conflict resolution is staged, but the merge commit is still in progress."
          : current.error ?? "Conflicts remain after resolution attempt."
    };
  }

  private async executeSingleItem(jobId: string, workItemId: string): Promise<JobState> {
    let job = await this.deps.store.loadJob(jobId);
    const repoInstructions = await loadRepoAgentsPreferences(job.repoRoot);
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
        const currentBranch = await tryGetCurrentBranch(workspace.workspacePath);
        if (currentBranch && currentBranch !== workspace.branchName) {
          await checkoutBranch(workspace.workspacePath, workspace.branchName);
        }
        let heartbeatWarned = false;
        const heartbeat = setInterval(() => {
          void this.persistRunningHeartbeat({
            jobId,
            workItemId: item.id,
            workspacePath: workspace.workspacePath,
            branchName: workspace.branchName,
            sessionId,
            attemptCount: updatedItem.attempts,
            prompt: resumePrompt ?? item.prompt,
            startedAt: updatedItem.startedAt,
            heartbeatWarned: () => heartbeatWarned,
            markWarned: () => {
              heartbeatWarned = true;
            }
          });
        }, this.getExecutionHeartbeatMs());

        let result: ExecutionResult;
        try {
          result = await this.deps.executor({
            prompt: buildInstructionAwarePrompt(item.prompt, repoInstructions, workspace.branchName),
            workspacePath: workspace.workspacePath,
            branchName: workspace.branchName,
            sessionId,
            resumePrompt,
            model: repoInstructions?.model,
            modelReasoningEffort: repoInstructions?.reasoningEffort,
            onSessionReady: async (readySessionId) => {
              sessionId = readySessionId;
              updatedItem = {
                ...updatedItem,
                sessionId: readySessionId
              };
              let currentJob = await this.deps.store.loadJob(jobId);
              currentJob = updateWorkItem(currentJob, updatedItem);
              currentJob = updateSession(currentJob, {
                workItemId: item.id,
                sessionId: readySessionId,
                status: "running",
                workspacePath: workspace.workspacePath,
                branchName: workspace.branchName,
                attemptCount: updatedItem.attempts,
                lastPrompt: resumePrompt ?? item.prompt,
                updatedAt: now()
              });
              currentJob = addEvent(currentJob, "info", "session", `Codex session started: ${readySessionId}`, item.id);
              await this.deps.store.saveJob(currentJob);
            }
          });
        } finally {
          clearInterval(heartbeat);
        }

        sessionId = result.sessionId ?? sessionId;
        updatedItem = {
          ...updatedItem,
          sessionId,
          lastResponse: result.summary
        };

        job = await this.deps.store.loadJob(jobId);
        const activeBranch = await tryGetCurrentBranch(workspace.workspacePath);
        if (activeBranch && activeBranch !== workspace.branchName) {
          throw new Error(
            `Workspace branch drift detected: expected '${workspace.branchName}' but Codex left the workspace on '${activeBranch}'.`
          );
        }

        if (result.status === "completed") {
          const finalization = this.deps.finalizeCompletedWorkItem
            ? await this.deps.finalizeCompletedWorkItem(job, updatedItem)
            : { committed: false };
          updatedItem.status = "completed";
          updatedItem.completedAt = now();
          updatedItem.failureCategory = undefined;
          updatedItem.retryable = undefined;
          updatedItem.manualReviewRequired = undefined;
          job = updateWorkItem(job, updatedItem);
          job = await this.refreshDerivedState(job);
          if (finalization.committed) {
            job = addEvent(job, "info", "session", "Committed workspace changes to the work-item branch.", item.id);
          }
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
          updatedItem.retryable = false;
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
            retryable: false,
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

  private async persistRunningHeartbeat(options: {
    jobId: string;
    workItemId: string;
    workspacePath: string;
    branchName: string;
    sessionId?: string;
    attemptCount: number;
    prompt: string;
    startedAt?: string;
    heartbeatWarned: () => boolean;
    markWarned: () => void;
  }): Promise<void> {
    try {
      let job = await this.deps.store.loadJob(options.jobId);
      const item = job.workItems.find((entry) => entry.id === options.workItemId);
      const session = job.sessions.find((entry) => entry.workItemId === options.workItemId);
      if (!item || item.status !== "running" || !session || session.status !== "running") {
        return;
      }

      const heartbeatTime = now();
      const progress = await collectWorkspaceProgress(options.workspacePath);
      const previousSummary = session.progressSummary;
      job = updateSession(job, {
        ...session,
        sessionId: session.sessionId ?? options.sessionId,
        workspacePath: session.workspacePath ?? options.workspacePath,
        branchName: session.branchName ?? options.branchName,
        attemptCount: options.attemptCount,
        lastPrompt: options.prompt,
        progressSummary: progress.progressSummary,
        changedFilesCount: progress.changedFilesCount,
        recentChangedFiles: progress.recentChangedFiles,
        lastWorkspaceActivityAt: progress.lastWorkspaceActivityAt,
        updatedAt: heartbeatTime
      });

      if (progress.progressSummary !== previousSummary) {
        job = addEvent(job, "info", "session", `Progress update: ${progress.progressSummary}`, options.workItemId);
        this.deps.progressReporter?.(`[felixai] progress ${options.workItemId}: ${progress.progressSummary}`);
      }

      const startedAtMillis = isoToMillis(options.startedAt);
      if (
        startedAtMillis !== undefined &&
        !options.heartbeatWarned() &&
        Date.now() - startedAtMillis >= this.getStaleRunningWarningMs()
      ) {
        job = addEvent(
          job,
          "warn",
          "session",
          `Execution still running after ${formatDurationFromMilliseconds(Date.now() - startedAtMillis)}. Inspect the workspace if progress appears stalled.`,
          options.workItemId
        );
        this.deps.progressReporter?.(
          `[felixai] warning ${options.workItemId}: execution still running after ${formatDurationFromMilliseconds(
            Date.now() - startedAtMillis
          )}`
        );
        options.markWarned();
      }

      await this.deps.store.saveJob(job);
    } catch {
      // Best-effort heartbeat only; do not interfere with the active execution path.
    }
  }
}
