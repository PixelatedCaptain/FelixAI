import path from "node:path";

import { ensureDirectory, pathExists } from "./fs-utils.js";
import { createWorktree, listWorktrees, pruneWorktrees, type WorktreeEntry } from "./git.js";
import type { WorkspaceAssignment } from "./types.js";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "work-item";
}

interface WorkspaceManagerOps {
  pathExists: typeof pathExists;
  createWorktree: typeof createWorktree;
  listWorktrees: (repoRoot: string) => Promise<WorktreeEntry[]>;
  pruneWorktrees: typeof pruneWorktrees;
}

export class WorkspaceManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly ops: WorkspaceManagerOps = {
      pathExists,
      createWorktree,
      listWorktrees,
      pruneWorktrees
    }
  ) {}

  async ensureWorkspace(
    jobId: string,
    workItemId: string,
    baseBranch: string,
    repoRoot: string,
    issueRefs: string[] = []
  ): Promise<WorkspaceAssignment> {
    const issueToken = issueRefs[0] ? `issue-${slugify(issueRefs[0])}` : slugify(workItemId);
    const branchName = `agent/${issueToken}/job-${jobId.slice(0, 8)}-${slugify(workItemId)}`;
    const workspacePath = path.join(this.workspaceRoot, jobId, slugify(workItemId));
    await ensureDirectory(path.dirname(workspacePath));
    await this.ops.pruneWorktrees(repoRoot);
    const worktrees = await this.ops.listWorktrees(repoRoot);
    const branchWorktree = worktrees.find((entry) => entry.branch === branchName);
    const normalizedWorkspacePath = path.resolve(workspacePath);

    if (branchWorktree && (await this.ops.pathExists(branchWorktree.path))) {
      return {
        branchName,
        workspacePath: branchWorktree.path,
        mode: path.resolve(branchWorktree.path) === normalizedWorkspacePath ? "reused" : "reattached",
        cleanupPerformed: true
      };
    }

    if (await this.ops.pathExists(workspacePath)) {
      const pathWorktree = worktrees.find((entry) => path.resolve(entry.path) === normalizedWorkspacePath);
      if (pathWorktree?.branch === branchName) {
        return {
          branchName,
          workspacePath,
          mode: "reused",
          cleanupPerformed: true
        };
      }
      throw new Error(
        `Workspace conflict: path '${workspacePath}' already exists${pathWorktree?.branch ? ` on branch '${pathWorktree.branch}'` : ""}.`
      );
    }

    await this.ops.createWorktree(repoRoot, workspacePath, branchName, baseBranch);

    return {
      branchName,
      workspacePath,
      mode: "created",
      cleanupPerformed: true
    };
  }
}
