import path from "node:path";

import { ensureDirectory, pathExists } from "./fs-utils.js";
import { createWorktree } from "./git.js";
import type { WorkspaceAssignment } from "./types.js";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "work-item";
}

export class WorkspaceManager {
  constructor(private readonly workspaceRoot: string) {}

  async ensureWorkspace(
    jobId: string,
    workItemId: string,
    baseBranch: string,
    repoRoot: string
  ): Promise<WorkspaceAssignment> {
    const branchName = `agent/${slugify(workItemId)}/job-${jobId.slice(0, 8)}`;
    const workspacePath = path.join(this.workspaceRoot, jobId, slugify(workItemId));
    await ensureDirectory(path.dirname(workspacePath));

    if (!(await pathExists(workspacePath))) {
      await createWorktree(repoRoot, workspacePath, branchName, baseBranch);
    }

    return {
      branchName,
      workspacePath
    };
  }
}
