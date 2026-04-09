import { loadConfig } from "./config.js";
import { snapshotUnfinishedGitHubIssues } from "./github-issues.js";
import { type GitHubIssueSnapshot, IssuePlanner, type IssuePlanningItem, type IssuePlanningResult } from "./issue-planner.js";
import { getIssuePlanPath, getIssueRunPath, saveIssuePlan, saveIssueRun } from "./issue-state.js";
import { createJobManager } from "./job-manager.js";
import { loadRepoAgentsPreferences } from "./repo-agents.js";
import type { JobState } from "./types.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

export type IssueExecutionStatus = "pending" | "running" | "blocked" | "completed" | "failed";
export type IssueRunOverallStatus = "running" | "paused" | "completed" | "failed";

export interface IssueExecutionRecord extends IssuePlanningItem {
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

function now(): string {
  return new Date().toISOString();
}

function formatIssueRef(issueNumber: number): string {
  return String(issueNumber);
}

function buildIssueTask(
  issue: { issueNumber: number; title: string; body?: string; latestSummary?: string; error?: string },
  directive: string
): string {
  const lines = [
    `GitHub issue #${issue.issueNumber}: ${issue.title}`,
    "",
    `Operator directive: ${directive}`
  ];

  if (issue.body?.trim()) {
    lines.push("", "Issue body:", issue.body.trim());
  }

  if (issue.latestSummary?.trim()) {
    lines.push("", "Prior FelixAI summary:", issue.latestSummary.trim());
  }

  if (issue.error?.trim()) {
    lines.push("", "Prior FelixAI error:", issue.error.trim());
  }

  lines.push("", "Implement the remaining work for this issue in the current repository and leave the repo ready for review.");
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
  const unresolved = job.workItems.filter((item) => item.status !== "completed");
  if (unresolved.length === 0) {
    return false;
  }

  return unresolved.every((item) => item.retryable !== false);
}

export function selectIssueWave(issues: IssueExecutionRecord[]): IssueExecutionRecord[] {
  const completed = new Set(
    issues.filter((issue) => issue.status === "completed").map((issue) => issue.issueNumber)
  );
  const eligible = issues.filter(
    (issue) =>
      issue.status === "pending" &&
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
      planIssues?: (
        input: {
          directive: string;
          repoRoot: string;
          issues: GitHubIssueSnapshot["issues"];
          model?: string;
          modelReasoningEffort?: ModelReasoningEffort;
          turboMode?: boolean;
          encourageSubagents?: boolean;
        }
      ) => Promise<IssuePlanningResult>;
    }
  ) {}

  async run(options: { repoRoot: string; directive: string }): Promise<IssueRunDocument> {
    const repoPreferences = await loadRepoAgentsPreferences(options.repoRoot);
    const snapshotter = this.deps?.snapshotter ?? snapshotUnfinishedGitHubIssues;
    const { snapshot, outputPath: snapshotPath } = await snapshotter(this.projectRoot, options.repoRoot);
    const config = await loadConfig(this.projectRoot);
    const planIssues =
      this.deps?.planIssues ??
      (async (input: Parameters<IssuePlanner["createIssuePlan"]>[0]) => {
        const planner = new IssuePlanner(config);
        return planner.createIssuePlan(input);
      });
    const plan = await planIssues({
      directive: options.directive,
      repoRoot: options.repoRoot,
      issues: snapshot.issues,
      model: repoPreferences?.model,
      modelReasoningEffort: repoPreferences?.reasoningEffort,
      turboMode: repoPreferences?.turboMode,
      encourageSubagents: repoPreferences?.encourageSubagents
    });

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
        status: "pending",
        jobIds: [],
        updatedAt: now()
      }))
    };
    await saveIssueRun(this.projectRoot, options.repoRoot, document);

    const issueByNumber = new Map(snapshot.issues.map((issue) => [issue.number, issue]));
    const manager = await this.managerFactory(this.projectRoot);

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
        wave.map((issue) => this.runSingleIssue(manager, document, issue, issueByNumber, options.directive))
      );

      const updates = new Map(completedWave.map((issue) => [issue.issueNumber, issue]));
      document = {
        ...document,
        updatedAt: now(),
        issues: document.issues.map((issue) => updates.get(issue.issueNumber) ?? issue)
      };

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
    issueByNumber: Map<number, GitHubIssueSnapshot["issues"][number]>,
    directive: string
  ): Promise<IssueExecutionRecord> {
    const issueDetails = issueByNumber.get(issue.issueNumber);
    let record: IssueExecutionRecord = {
      ...issue,
      status: "running",
      startedAt: issue.startedAt ?? now(),
      updatedAt: now(),
      error: undefined
    };
    await this.saveIssueRecord(document, record);

    let attempts = 0;
    let currentJob: JobState | undefined;

    while (attempts < 3) {
      attempts += 1;

      currentJob = await manager.startJob({
        repoPath: document.repoRoot,
        task: buildIssueTask(
          {
            issueNumber: issue.issueNumber,
            title: issue.title,
            body: issueDetails?.body,
            latestSummary: record.latestSummary,
            error: record.error
          },
          directive
        ),
        issueRefs: [formatIssueRef(issue.issueNumber)],
        autoResume: true
      });

      record = {
        ...record,
        jobIds: [...record.jobIds, currentJob.jobId],
        lastJobId: currentJob.jobId,
        lastJobStatus: currentJob.status,
        latestSummary: summarizeJobForIssue(currentJob),
        updatedAt: now(),
        error: currentJob.status === "completed" ? undefined : currentJob.workItems.find((item) => item.error)?.error
      };
      await this.saveIssueRecord(document, record);

      if (currentJob.status === "completed") {
        return {
          ...record,
          status: "completed",
          completedAt: now(),
          updatedAt: now(),
          error: undefined
        };
      }

      if (jobCanAutoContinue(currentJob)) {
        continue;
      }

      return {
        ...record,
        status: currentJob.status === "failed" ? "failed" : "blocked",
        updatedAt: now(),
        error: currentJob.workItems.find((item) => item.error)?.error ?? `Issue run stopped with job status '${currentJob.status}'.`
      };
    }

    return {
      ...record,
      status: "blocked",
      updatedAt: now(),
      error: record.error ?? "Issue run hit the maximum retry budget before reaching completion."
    };
  }

  private async saveIssueRecord(document: IssueRunDocument, record: IssueExecutionRecord): Promise<void> {
    const next: IssueRunDocument = {
      ...document,
      updatedAt: now(),
      issues: document.issues.map((issue) => (issue.issueNumber === record.issueNumber ? record : issue))
    };
    await saveIssueRun(this.projectRoot, document.repoRoot, next);
  }
}
