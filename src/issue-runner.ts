import path from "node:path";

import {
  fetchGitHubIssue,
  snapshotUnfinishedGitHubIssues,
  type GitHubIssueExecutionLane,
  type GitHubIssueRecord
} from "./github-issues.js";
import {
  addLabelsToGitHubIssue,
  closeGitHubIssue,
  ensureGitHubLabel,
  removeLabelsFromGitHubIssue
} from "./github.js";
import { getIssuePlanPath, getIssueRunPath, saveIssuePlan, saveIssueRun } from "./issue-state.js";
import { createJobManager } from "./job-manager.js";
import { type IssueDirectiveScope, parseIssueDirectiveScope } from "./issue-directives.js";
import type { IssuePlanningItem } from "./issue-planner.js";
import { ensureSharedRepoContext, loadRepoAgentsPreferences, type SharedRepoContext } from "./repo-agents.js";
import { runCodexCliIssueSession } from "./codex-cli-exec.js";
import { loadConfig } from "./config.js";
import { StateStore } from "./state-store.js";
import {
  checkoutBranch,
  getCurrentBranch,
  getPreferredRemote,
  listWorkingTreeChanges,
  mergeBranchIntoCurrent,
  pushBranch
} from "./git.js";
import type { JobState } from "./types.js";
export type IssueExecutionStatus = "pending" | "running" | "blocked" | "completed" | "failed";
export type IssueRunOverallStatus = "running" | "paused" | "completed" | "failed";
export type IssueExecutionPhase = "implementation" | "validation";

export interface IssueExecutionRecord extends IssuePlanningItem {
  lane: GitHubIssueExecutionLane;
  phase: IssueExecutionPhase;
  status: IssueExecutionStatus;
  jobIds: string[];
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastJobId?: string;
  lastJobStatus?: JobState["status"];
  latestSummary?: string;
  error?: string;
}

export interface IssueRunDocument {
  repoRoot: string;
  generatedAt: string;
  updatedAt: string;
  directive: string;
  snapshotPath: string;
  planPath: string;
  runPath?: string;
  summary: string;
  status: IssueRunOverallStatus;
  issues: IssueExecutionRecord[];
}

const ISSUE_MAX_ATTEMPTS = 3;

function now(): string {
  return new Date().toISOString();
}

function formatIssueRef(issueNumber: number): string {
  return String(issueNumber);
}

function buildIssueTask(
  issue: { issueNumber: number; title: string; labels?: string[] },
  phase: IssueExecutionPhase,
  sharedRepoContext?: SharedRepoContext
): string {
  const lines = [
    `Work GitHub issue #${issue.issueNumber}: ${issue.title}.`,
    sharedRepoContext
      ? `Read the shared repo context first: ${sharedRepoContext.contextPath}.`
      : "Read AGENTS.md first.",
    sharedRepoContext ? "Consult AGENTS.md only if the shared repo context is missing something important." : undefined,
    "Inspect the live GitHub issue and current repository state before changing code.",
    "Use the GitHub issue itself as the source of truth for the remaining work and acceptance criteria.",
    `Execution phase: ${phase}`
  ].filter((value): value is string => Boolean(value));

  if (issue.labels && issue.labels.length > 0) {
    lines.push(`Current GitHub labels: ${issue.labels.join(", ")}`);
  }

  if (phase === "implementation") {
    lines.push(
      "Implement the remaining work for this issue in the current repository.",
      "When the implementation is ready for focused validation, add the GitHub label `ready-to-test`.",
      "Do not close the issue during the implementation phase unless the issue is already fully validated."
    );
  } else {
    lines.push(
      "Validate this issue end to end.",
      "If focused unit or regression tests are missing, add them before running validation.",
      "Run the most relevant automated tests for the changed behavior.",
      "If validation passes, remove the `ready-to-test` label, add the `done` label, and close or move the issue to done.",
      "If validation does not pass, keep the issue open and leave clear failure details in your summary."
    );
  }

  return lines.join("\n");
}

function summarizeJobForIssue(job: JobState): string | undefined {
  const recentResponse = [...job.workItems]
    .map((item) => item.lastResponse)
    .filter((value): value is string => Boolean(value))
    .at(-1);
  return recentResponse ?? job.planningSummary;
}

function jobCanAutoContinue(job: JobState): boolean {
  return job.status !== "completed";
}

function issueHasLabel(issue: Pick<GitHubIssueRecord, "labels">, label: string): boolean {
  return issue.labels.some((existing) => existing.toLowerCase() === label.toLowerCase());
}

function determineIssuePhase(issue: Pick<GitHubIssueRecord, "labels">): IssueExecutionPhase {
  return issueHasLabel(issue, "ready-to-test") ? "validation" : "implementation";
}

function shouldAdvanceToValidationPhase(
  completedPhase: IssueExecutionPhase,
  issue: Pick<GitHubIssueRecord, "labels" | "state">
): boolean {
  return completedPhase === "implementation" && issue.state.toUpperCase() === "OPEN" && determineIssuePhase(issue) === "validation";
}

function hasBlockingRepoChanges(changedFiles: string[]): boolean {
  return changedFiles.some((entry) => {
    const normalized = entry.replace(/\\/g, "/");
    return normalized !== "AGENTS.md" && !normalized.startsWith(".felixai/");
  });
}

export function selectIssueWave(issues: IssueExecutionRecord[]): IssueExecutionRecord[] {
  const completed = new Set(
    issues.filter((issue) => issue.status === "completed").map((issue) => issue.issueNumber)
  );
  const eligible = issues.filter(
    (issue) =>
      issue.status === "pending" &&
      issue.lane !== "blocked" &&
      issue.dependsOn.every((dependency) => completed.has(dependency))
  );

  if (eligible.length === 0) {
    return [];
  }

  const parallel = eligible.filter((issue) => issue.parallelSafe && issue.overlapRisk === "low");
  if (parallel.length > 0) {
    return parallel;
  }

  return [eligible[0] as IssueExecutionRecord];
}

export class IssueRunner {
  constructor(
    private readonly projectRoot: string,
    private readonly managerFactory: typeof createJobManager = createJobManager,
    private readonly deps?: {
      snapshotter?: typeof snapshotUnfinishedGitHubIssues;
      fetchIssue?: typeof fetchGitHubIssue;
      ensureLabel?: typeof ensureGitHubLabel;
      addIssueLabels?: typeof addLabelsToGitHubIssue;
      removeIssueLabels?: typeof removeLabelsFromGitHubIssue;
      closeIssue?: typeof closeGitHubIssue;
    }
  ) {}

  async run(options: { repoRoot: string; directive: string; scope?: IssueDirectiveScope }): Promise<IssueRunDocument> {
    const repoPreferences = await loadRepoAgentsPreferences(options.repoRoot);
    const sharedRepoContext = await ensureSharedRepoContext(this.projectRoot, options.repoRoot);
    const config = await loadConfig(this.projectRoot);
    const store = new StateStore(this.projectRoot, { stateDir: config.stateDir, logDir: config.logDir });
    const scope = options.scope ?? parseIssueDirectiveScope("issues", [options.directive]);
    const snapshotter = this.deps?.snapshotter ?? snapshotUnfinishedGitHubIssues;
    const { snapshot: fullSnapshot, outputPath: snapshotPath } = await snapshotter(this.projectRoot, options.repoRoot);
    const filteredIssues = fullSnapshot.issues.filter((issue) => {
      const matchesIssueNumbers = scope.issueNumbers.length === 0 || scope.issueNumbers.includes(issue.number);
      const matchesLabels = scope.labelFilters.length === 0 || scope.labelFilters.some((label) => issue.labels.includes(label));
      return matchesIssueNumbers && matchesLabels;
    });
    if (filteredIssues.length === 0) {
      throw new Error("No unfinished GitHub issues matched the requested issue numbers and labels.");
    }
    const snapshot = {
      ...fullSnapshot,
      issues: filteredIssues
    };
    const ensureLabel = this.deps?.ensureLabel ?? ensureGitHubLabel;
    const addIssueLabels = this.deps?.addIssueLabels ?? addLabelsToGitHubIssue;
    const removeIssueLabels = this.deps?.removeIssueLabels ?? removeLabelsFromGitHubIssue;
    const closeIssue = this.deps?.closeIssue ?? closeGitHubIssue;
    await ensureLabel({
      repoPath: options.repoRoot,
      name: "ready-to-test",
      color: "0e8a16",
      description: "Implementation is ready for focused validation."
    });
    await ensureLabel({
      repoPath: options.repoRoot,
      name: "done",
      color: "1d76db",
      description: "Validation passed and the issue is complete."
    });
    const metadataErrors = snapshot.issues
      .filter((issue) => (issue.executionMetadata?.validationErrors.length ?? 0) > 0)
      .map((issue) => `#${issue.number}: ${issue.executionMetadata?.validationErrors.join(" ")}`);
    if (metadataErrors.length > 0) {
      throw new Error(`GitHub issues are missing required Felix execution metadata.\n${metadataErrors.join("\n")}`);
    }

    const plan = {
      summary: `Prepared ${snapshot.issues.length} GitHub issue(s) for Felix execution from issue metadata.`,
      orderedIssues: [...snapshot.issues]
        .sort((left, right) => left.number - right.number)
        .map((issue) => ({
          issueNumber: issue.number,
          title: issue.title,
          lane: issue.executionMetadata?.lane ?? "ordered",
          dependsOn: issue.executionMetadata?.dependsOn ?? [],
          parallelSafe: issue.executionMetadata?.parallelSafe ?? false,
          overlapRisk:
            issue.executionMetadata?.lane === "ready-parallel"
              ? ("low" as const)
              : issue.executionMetadata?.lane === "blocked"
                ? ("high" as const)
                : ("medium" as const),
          reasoning: `Scheduled from issue metadata lane '${issue.executionMetadata?.lane ?? "ordered"}'.`
        }))
    };

    const planDocument = {
      repoRoot: options.repoRoot,
      generatedAt: now(),
      directive: options.directive,
      snapshotPath,
      orderedIssues: plan.orderedIssues,
      summary: plan.summary
    };
    const planPath = await saveIssuePlan(this.projectRoot, options.repoRoot, planDocument);

    let document: IssueRunDocument = {
      repoRoot: options.repoRoot,
      generatedAt: now(),
      updatedAt: now(),
      directive: options.directive,
      snapshotPath,
      planPath,
      runPath: getIssueRunPath(this.projectRoot, options.repoRoot),
      summary: plan.summary,
      status: "running",
      issues: plan.orderedIssues.map((issue) => ({
        ...issue,
        phase: "implementation",
        status: "pending",
        jobIds: [],
        updatedAt: now()
      }))
    };
    await saveIssueRun(this.projectRoot, options.repoRoot, document);

    const issueByNumber = new Map(snapshot.issues.map((issue) => [issue.number, issue]));
    const manager = await this.managerFactory(this.projectRoot, {
      planner: async (task) => ({
        summary: "Single-session issue execution attempt.",
        workItems: [
          {
            id: "issue-attempt",
            title: "Issue execution attempt",
            prompt: task,
            dependsOn: []
          }
        ]
      }),
      executor: async (execution) =>
        runCodexCliIssueSession({
          prompt: execution.prompt,
          workspacePath: execution.workspacePath,
          model: repoPreferences?.model,
          modelReasoningEffort: repoPreferences?.reasoningEffort,
          sandboxMode: config.codex.sandboxMode,
          networkAccessEnabled: config.codex.networkAccessEnabled,
          onSessionReady: execution.onSessionReady
        })
    });

    while (true) {
      const wave = selectIssueWave(document.issues);
      if (wave.length === 0) {
        const pending = document.issues.some((issue) => issue.status === "pending");
        const blocked = document.issues.some((issue) => issue.status === "blocked");
        const failed = document.issues.some((issue) => issue.status === "failed");
        document = {
          ...document,
          updatedAt: now(),
          status: failed ? "failed" : blocked || pending ? "paused" : "completed"
        };
        await saveIssueRun(this.projectRoot, options.repoRoot, document);
        return document;
      }

      const completedWave = await Promise.all(
        wave.map((issue) =>
          this.runSingleIssue(
            manager,
            document,
            issue,
            issueByNumber,
            options.directive,
            repoPreferences,
            sharedRepoContext,
            { addIssueLabels, removeIssueLabels, closeIssue },
            store
          )
        )
      );

      const updates = new Map(completedWave.map((issue) => [issue.issueNumber, issue]));
      document = {
        ...document,
        updatedAt: now(),
        issues: document.issues.map((issue) => updates.get(issue.issueNumber) ?? issue)
      };

      if (scope.implementFirstOnly && completedWave.some((issue) => issue.status === "completed")) {
        document = {
          ...document,
          updatedAt: now(),
          status: "completed",
          summary: `${document.summary} First matching issue implemented; stopping as requested.`
        };
        await saveIssueRun(this.projectRoot, options.repoRoot, document);
        return document;
      }

      if (document.issues.every((issue) => issue.status === "completed")) {
        document = {
          ...document,
          updatedAt: now(),
          status: "completed"
        };
        await saveIssueRun(this.projectRoot, options.repoRoot, document);
        return document;
      }

      await saveIssueRun(this.projectRoot, options.repoRoot, document);
    }
  }

  private async runSingleIssue(
    manager: Awaited<ReturnType<typeof createJobManager>>,
    document: IssueRunDocument,
    issue: IssueExecutionRecord,
    issueByNumber: Map<number, GitHubIssueRecord>,
    directive: string,
    repoPreferences?: Awaited<ReturnType<typeof loadRepoAgentsPreferences>>,
    sharedRepoContext?: SharedRepoContext,
    githubActions?: {
      addIssueLabels: typeof addLabelsToGitHubIssue;
      removeIssueLabels: typeof removeLabelsFromGitHubIssue;
      closeIssue: typeof closeGitHubIssue;
    },
    store?: StateStore
  ): Promise<IssueExecutionRecord> {
    const issueDetails = issueByNumber.get(issue.issueNumber);
    const fetchIssue = this.deps?.fetchIssue ?? fetchGitHubIssue;
    let record: IssueExecutionRecord = {
      ...issue,
      phase: determineIssuePhase(issueDetails ?? { labels: [] }),
      status: "running",
      startedAt: issue.startedAt ?? now(),
      updatedAt: now(),
      error: undefined
    };
    await this.saveIssueRecord(document, record);

    let attempts = 0;
    let currentJob: JobState | undefined;

    let liveIssue = issueDetails ?? (await fetchIssue(document.repoRoot, issue.issueNumber));

    while (attempts < ISSUE_MAX_ATTEMPTS) {
      attempts += 1;
      const phase = determineIssuePhase(liveIssue);

      currentJob = await manager.startJob({
        repoPath: document.repoRoot,
        task: buildIssueTask(
          {
            issueNumber: issue.issueNumber,
            title: issue.title,
            labels: liveIssue.labels
          },
          phase,
          sharedRepoContext
        ),
        issueRefs: [formatIssueRef(issue.issueNumber)],
        autoResume: false,
        parallelism: 1
      });

      record = {
        ...record,
        jobIds: [...record.jobIds, currentJob.jobId],
        lastJobId: currentJob.jobId,
        lastJobStatus: currentJob.status,
        phase,
        latestSummary: summarizeJobForIssue(currentJob),
        updatedAt: now(),
        error: currentJob.status === "completed" ? undefined : currentJob.workItems.find((item) => item.error)?.error
      };
      await this.saveIssueRecord(document, record);

      if (currentJob.status === "completed" && githubActions) {
        if (phase === "implementation") {
          await githubActions.addIssueLabels({
            repoPath: document.repoRoot,
            issueNumber: issue.issueNumber,
            labels: ["ready-to-test"]
          });
        } else {
          const finalizedBranch = currentJob.workItems.find((item) => item.id === "issue-attempt")?.branchName;
          if (!finalizedBranch) {
            throw new Error("Validation completed but Felix could not determine the source branch for finalization.");
          }
          await this.finalizeIssueBranch(document.repoRoot, currentJob.baseBranch, finalizedBranch);
          await githubActions.removeIssueLabels({
            repoPath: document.repoRoot,
            issueNumber: issue.issueNumber,
            labels: ["ready-to-test"]
          });
          await githubActions.addIssueLabels({
            repoPath: document.repoRoot,
            issueNumber: issue.issueNumber,
            labels: ["done"]
          });
          await githubActions.closeIssue({
            repoPath: document.repoRoot,
            issueNumber: issue.issueNumber,
            comment: "Felix validation passed and the issue is complete."
          });
        }
      }

      liveIssue = await fetchIssue(document.repoRoot, issue.issueNumber);
      if (shouldAdvanceToValidationPhase(phase, liveIssue)) {
        record = {
          ...record,
          phase: "validation",
          updatedAt: now(),
          error: undefined
        };
        await this.saveIssueRecord(document, record);
        continue;
      }

      if (this.isIssueComplete(liveIssue)) {
        if (store) {
          await this.archiveSupersededIssueJobs(store, document.repoRoot, issue.issueNumber, [currentJob.jobId]);
        }
        return {
          ...record,
          phase: determineIssuePhase(liveIssue),
          status: "completed",
          completedAt: now(),
          updatedAt: now(),
          error: undefined
        };
      }

      if (attempts < ISSUE_MAX_ATTEMPTS && jobCanAutoContinue(currentJob)) {
        continue;
      }

      if (attempts < ISSUE_MAX_ATTEMPTS) {
        continue;
      }
    }

    return {
      ...record,
      status: "blocked",
      updatedAt: now(),
      error: record.error ?? `Issue run hit the maximum retry budget (${ISSUE_MAX_ATTEMPTS}) before the GitHub issue reached done state.`
    };
  }

  private isIssueComplete(issue: GitHubIssueRecord): boolean {
    if (issue.state.toUpperCase() !== "OPEN" || issueHasLabel(issue, "done")) {
      return true;
    }
    return false;
  }

  private async saveIssueRecord(document: IssueRunDocument, record: IssueExecutionRecord): Promise<void> {
    const next: IssueRunDocument = {
      ...document,
      updatedAt: now(),
      issues: document.issues.map((issue) => (issue.issueNumber === record.issueNumber ? record : issue))
    };
    await saveIssueRun(this.projectRoot, document.repoRoot, next);
  }

  private async finalizeIssueBranch(repoRoot: string, baseBranch: string, sourceBranch: string): Promise<void> {
    const changedFiles = await listWorkingTreeChanges(repoRoot);
    if (hasBlockingRepoChanges(changedFiles)) {
      throw new Error(
        `Cannot finalize '${sourceBranch}' into '${baseBranch}' because the repository root has pending changes outside .felixai/.`
      );
    }

    const currentBranch = await getCurrentBranch(repoRoot);
    if (currentBranch !== baseBranch) {
      await checkoutBranch(repoRoot, baseBranch);
    }

    await mergeBranchIntoCurrent(repoRoot, sourceBranch);

    const remoteName = await getPreferredRemote(repoRoot);
    if (remoteName) {
      await pushBranch(repoRoot, baseBranch, remoteName);
    }
  }

  private async archiveSupersededIssueJobs(
    store: StateStore,
    repoRoot: string,
    issueNumber: number,
    keepJobIds: string[]
  ): Promise<void> {
    const keep = new Set(keepJobIds);
    const jobs = await store.listJobs();
    for (const job of jobs) {
      if (path.resolve(job.repoRoot) !== path.resolve(repoRoot)) {
        continue;
      }
      if (keep.has(job.jobId)) {
        continue;
      }
      if (job.status === "planning") {
        continue;
      }
      if (!job.issueRefs.includes(formatIssueRef(issueNumber))) {
        continue;
      }
      await store.archiveJob(job.jobId);
    }
  }
}
