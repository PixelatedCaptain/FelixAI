import path from "node:path";

import { ensureDirectory, listJsonFiles, pathExists, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { JobLogger } from "./logger.js";
import type { JobEvent, JobState, SessionState, WorkItemState } from "./types.js";
import { migrateJobState, validateJobState } from "./validation.js";

export class StateStore {
  private readonly logger: JobLogger;
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly jobsDirPath: string;
  private readonly plansDirPath: string;

  constructor(projectRoot: string, options: { stateDir: string; logDir: string }) {
    const stateRoot = path.join(path.resolve(projectRoot), options.stateDir);
    this.jobsDirPath = path.join(stateRoot, "jobs");
    this.plansDirPath = path.join(stateRoot, "plans");
    this.logger = new JobLogger(path.resolve(projectRoot, options.logDir));
  }

  get jobsDir(): string {
    return this.jobsDirPath;
  }

  async ensure(): Promise<void> {
    await ensureDirectory(this.jobsDir);
    await ensureDirectory(this.plansDirPath);
    await this.logger.ensure();
  }

  getJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  getPlanPath(jobId: string): string {
    return path.join(this.plansDirPath, `${jobId}.plan.json`);
  }

  async saveJob(job: JobState): Promise<void> {
    await this.ensure();
    const validated = validateJobState(job);
    const previous = this.pendingWrites.get(validated.jobId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const merged = await this.mergeWithCurrent(validated);
      await writeJsonFile(this.getJobPath(merged.jobId), merged);
      await this.logger.syncJob(merged);
    });

    this.pendingWrites.set(validated.jobId, next);
    await next;
  }

  async loadJob(jobId: string): Promise<JobState> {
    await this.pendingWrites.get(jobId);
    const raw = await readJsonFile<unknown>(this.getJobPath(jobId));
    return validateJobState(migrateJobState(raw));
  }

  async listJobs(): Promise<JobState[]> {
    await this.ensure();
    const files = await listJsonFiles(this.jobsDir);
    const jobs = await Promise.all(files.map(async (file) => validateJobState(migrateJobState(await readJsonFile<unknown>(file)))));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async savePlan(jobId: string, value: unknown): Promise<void> {
    await this.ensure();
    await writeJsonFile(this.getPlanPath(jobId), value);
  }

  private async mergeWithCurrent(incoming: JobState): Promise<JobState> {
    const jobPath = this.getJobPath(incoming.jobId);
    if (!(await pathExists(jobPath))) {
      return incoming;
    }

    const current = validateJobState(migrateJobState(await readJsonFile<unknown>(jobPath)));
    return mergeJobStates(current, incoming);
  }
}

const workItemStatusRank: Record<WorkItemState["status"], number> = {
  pending: 0,
  running: 1,
  boundary: 2,
  blocked: 3,
  completed: 4,
  failed: 5
};

const sessionStatusRank: Record<SessionState["status"], number> = {
  pending: 0,
  running: 1,
  boundary: 2,
  blocked: 3,
  completed: 4,
  failed: 5
};

function mergeWorkItems(current: WorkItemState[], incoming: WorkItemState[]): WorkItemState[] {
  const merged = new Map<string, WorkItemState>();
  for (const item of current) {
    merged.set(item.id, item);
  }
  for (const item of incoming) {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, item);
      continue;
    }

    const preferred =
      workItemStatusRank[item.status] > workItemStatusRank[existing.status] ||
      item.attempts > existing.attempts ||
      (item.completedAt ?? "") > (existing.completedAt ?? "") ||
      (item.startedAt ?? "") > (existing.startedAt ?? "")
        ? item
        : existing;
    merged.set(item.id, {
      ...existing,
      ...preferred,
      dependsOn: preferred.dependsOn
    });
  }
  return [...merged.values()];
}

function mergeSessions(current: SessionState[], incoming: SessionState[]): SessionState[] {
  const merged = new Map<string, SessionState>();
  for (const session of current) {
    merged.set(session.workItemId, session);
  }
  for (const session of incoming) {
    const existing = merged.get(session.workItemId);
    if (!existing) {
      merged.set(session.workItemId, session);
      continue;
    }

    const preferred =
      sessionStatusRank[session.status] > sessionStatusRank[existing.status] ||
      session.attemptCount > existing.attemptCount ||
      session.updatedAt > existing.updatedAt
        ? session
        : existing;
    merged.set(session.workItemId, { ...existing, ...preferred });
  }
  return [...merged.values()];
}

function mergeEvents(current: JobEvent[], incoming: JobEvent[]): JobEvent[] {
  const seen = new Set<string>();
  const merged: JobEvent[] = [];
  for (const event of [...current, ...incoming]) {
    const key = `${event.timestamp}|${event.level}|${event.scope}|${event.workItemId ?? ""}|${event.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function deriveStatus(job: JobState): JobState["status"] {
  if (job.workItems.some((item) => item.status === "failed")) {
    return "failed";
  }
  if (job.workItems.length > 0 && job.workItems.every((item) => item.status === "completed")) {
    return "completed";
  }
  if (job.workItems.some((item) => item.status === "boundary" || item.status === "blocked")) {
    return "paused";
  }
  if (job.workItems.some((item) => item.status === "running")) {
    return "running";
  }
  return job.status;
}

function mergeJobStates(current: JobState, incoming: JobState): JobState {
  const workItems = mergeWorkItems(current.workItems, incoming.workItems);
  const sessions = mergeSessions(current.sessions, incoming.sessions);
  const events = mergeEvents(current.events, incoming.events);
  return {
    ...current,
    ...incoming,
    workItems,
    sessions,
    events,
    mergeReadiness: {
      completedBranches: workItems.filter((item) => item.status === "completed" && item.branchName).map((item) => item.branchName as string),
      pendingBranches: workItems.filter((item) => item.status !== "completed" && item.branchName).map((item) => item.branchName as string),
      branchReadiness:
        incoming.mergeReadiness.branchReadiness.length > 0 ? incoming.mergeReadiness.branchReadiness : current.mergeReadiness.branchReadiness,
      generatedAt: incoming.mergeReadiness.generatedAt ?? current.mergeReadiness.generatedAt
    },
    mergeAutomation:
      incoming.mergeAutomation.attemptedAt || incoming.mergeAutomation.error || incoming.mergeAutomation.mergedBranches.length > 0
        ? incoming.mergeAutomation
        : current.mergeAutomation,
    remoteBranches: incoming.remoteBranches.length > 0 ? incoming.remoteBranches : current.remoteBranches,
    pullRequests: incoming.pullRequests.length > 0 ? incoming.pullRequests : current.pullRequests,
    issueSummaries: incoming.issueSummaries.length > 0 ? incoming.issueSummaries : current.issueSummaries,
    updatedAt: incoming.updatedAt > current.updatedAt ? incoming.updatedAt : current.updatedAt,
    status: deriveStatus({
      ...incoming,
      workItems,
      sessions,
      events
    })
  };
}
