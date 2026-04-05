import path from "node:path";
import { writeFile } from "node:fs/promises";

import { ensureDirectory, writeJsonFile } from "./fs-utils.js";
import type { JobEvent, JobState } from "./types.js";

export interface LoggedEvent extends JobEvent {
  jobId: string;
  sequence: number;
}

export class JobLogger {
  constructor(private readonly logDir: string) {}

  get jobsDir(): string {
    return path.join(this.logDir, "jobs");
  }

  async ensure(): Promise<void> {
    await ensureDirectory(this.jobsDir);
  }

  getEventLogPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.events.jsonl`);
  }

  getSummaryPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.summary.json`);
  }

  async syncJob(job: JobState): Promise<void> {
    await this.ensure();
    const lines = job.events.map((event, index) =>
      JSON.stringify({
        ...event,
        jobId: job.jobId,
        sequence: index + 1
      } satisfies LoggedEvent)
    );

    await writeFile(this.getEventLogPath(job.jobId), `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
    await writeJsonFile(this.getSummaryPath(job.jobId), {
      jobId: job.jobId,
      status: job.status,
      updatedAt: job.updatedAt,
      totalEvents: job.events.length,
      mergeAutomation: job.mergeAutomation,
      remoteBranches: job.remoteBranches,
      pullRequests: job.pullRequests,
      issueSummaries: job.issueSummaries,
      workItems: job.workItems.map((item) => ({
        id: item.id,
        status: item.status,
        branchName: item.branchName ?? null,
        sessionId: item.sessionId ?? null,
        issueRefs: item.issueRefs ?? [],
        failureCategory: item.failureCategory ?? null,
        retryable: item.retryable ?? null,
        manualReviewRequired: item.manualReviewRequired ?? null
      }))
    });
  }
}
