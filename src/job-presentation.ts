import { loadCurrentShellSession } from "./issue-state.js";
import type { JobState } from "./types.js";

export function summarizeJob(job: JobState): {
  pending: number;
  running: number;
  boundary: number;
  blocked: number;
  completed: number;
  failed: number;
} {
  return job.workItems.reduce(
    (summary, item) => {
      summary[item.status] += 1;
      return summary;
    },
    {
      pending: 0,
      running: 0,
      boundary: 0,
      blocked: 0,
      completed: 0,
      failed: 0
    }
  );
}

export function inferJobPhase(job: JobState): string | undefined {
  const candidates = [job.task, ...job.workItems.map((item) => item.prompt)];
  for (const candidate of candidates) {
    const match = candidate.match(/Execution phase:\s*(implementation|validation)/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

export function formatDuration(durationMs: number): string {
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

export function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function formatJobListBlock(job: JobState, taskSummary: string): string {
  const summary = summarizeJob(job);
  const primarySession =
    job.sessions.find((session) => session.status === "running") ??
    job.sessions.find((session) => Boolean(session.sessionId));
  const primarySessionId = primarySession?.sessionId;
  const phase = inferJobPhase(job);
  const issueRefs = job.issueRefs.length > 0 ? job.issueRefs.map((issue) => `#${issue}`).join(", ") : "none";
  const lines = [
    `Job ID: ${job.jobId}`,
    `  Status: ${job.status}`,
    `  Branch: ${job.baseBranch}`,
    `  Issues: ${issueRefs}`,
    `  Work Items: done=${summary.completed}/${job.workItems.length} running=${summary.running} failed=${summary.failed}`,
    `  Task: ${taskSummary}`
  ];

  if (primarySessionId) {
    lines.splice(4, 0, `  Session: ${primarySessionId}`);
  }
  if (phase) {
    lines.splice(primarySessionId ? 5 : 4, 0, `  Phase: ${phase}`);
  }
  if (primarySession?.changedFilesCount !== undefined) {
    lines.push(`  Changed Files: ${primarySession.changedFilesCount}`);
  }
  if (primarySession?.lastWorkspaceActivityAt) {
    const lastActivity = parseIsoTimestamp(primarySession.lastWorkspaceActivityAt);
    if (lastActivity !== undefined) {
      lines.push(`  Last File Update: ${formatDuration(Date.now() - lastActivity)} ago`);
    }
  }
  if (primarySession?.recentChangedFiles && primarySession.recentChangedFiles.length > 0) {
    lines.push(`  Recent Files: ${primarySession.recentChangedFiles.join(", ")}`);
  }

  return lines.join("\n");
}

export interface JobListView {
  jobs: JobState[];
  shellSessionId?: string;
}

export async function filterJobsForCurrentShellSession(repoRoot: string, jobs: JobState[]): Promise<JobListView> {
  const currentShell = await loadCurrentShellSession<{ shellSessionId?: string }>(repoRoot, repoRoot).catch(() => undefined);
  const shellSessionId = currentShell?.shellSessionId;
  if (!shellSessionId) {
    return { jobs, shellSessionId: undefined };
  }

  const scopedJobs = jobs.filter((job) => job.shellSessionId === shellSessionId);
  if (scopedJobs.length === 0) {
    return { jobs, shellSessionId };
  }

  return { jobs: scopedJobs, shellSessionId };
}
