import path from "node:path";

import { ensureDirectory, listJsonFiles, readJsonFile, writeJsonFile } from "./fs-utils.js";
import type { JobState } from "./types.js";

export class StateStore {
  constructor(private readonly root: string) {}

  get jobsDir(): string {
    return path.join(this.root, "state", "jobs");
  }

  async ensure(): Promise<void> {
    await ensureDirectory(this.jobsDir);
  }

  getJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  async saveJob(job: JobState): Promise<void> {
    await this.ensure();
    await writeJsonFile(this.getJobPath(job.jobId), job);
  }

  async loadJob(jobId: string): Promise<JobState> {
    return readJsonFile<JobState>(this.getJobPath(jobId));
  }

  async listJobs(): Promise<JobState[]> {
    await this.ensure();
    const files = await listJsonFiles(this.jobsDir);
    const jobs = await Promise.all(files.map((file) => readJsonFile<JobState>(file)));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
