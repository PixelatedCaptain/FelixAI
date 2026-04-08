import path from "node:path";

import { runCommand } from "./process-utils.js";
import { ensureDirectory } from "./fs-utils.js";
import type { PushStatus } from "./types.js";

export interface WorktreeEntry {
  path: string;
  branch?: string;
  bare: boolean;
}

export async function assertGitRepository(repoPath: string): Promise<void> {
  try {
    await runCommand("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Repository validation failed for '${repoPath}': ${message}`);
  }
}

export async function resolveGitRoot(repoPath: string): Promise<string> {
  const result = await runCommand("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
  return result.stdout;
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await runCommand("git", ["-C", repoPath, "branch", "--show-current"]);
  if (!result.stdout) {
    throw new Error("Could not determine the current Git branch.");
  }

  return result.stdout;
}

export async function checkoutBranch(repoPath: string, branchName: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "checkout", branchName]);
}

export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await runCommand("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

export async function baseBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await runCommand("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    try {
      await runCommand("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }
}

export async function isWorkingTreeDirty(repoPath: string): Promise<boolean> {
  const result = await runCommand("git", ["-C", repoPath, "status", "--porcelain"]);
  return result.stdout.length > 0;
}

export async function createWorktree(repoPath: string, workspacePath: string, branchName: string, baseBranch: string): Promise<void> {
  if (await branchExists(repoPath, branchName)) {
    await runCommand("git", ["-C", repoPath, "worktree", "add", workspacePath, branchName]);
    return;
  }

  await runCommand("git", ["-C", repoPath, "worktree", "add", "-b", branchName, workspacePath, baseBranch]);
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "worktree", "prune"]);
}

export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const result = await runCommand("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  if (!result.stdout) {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = {
        path: line.slice("worktree ".length).trim(),
        bare: false
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      continue;
    }
    if (line.trim() === "bare") {
      current.bare = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

export async function listChangedFiles(repoPath: string, baseBranch: string, branchName: string): Promise<string[]> {
  const result = await runCommand("git", ["-C", repoPath, "diff", "--name-only", `${baseBranch}...${branchName}`]);
  if (!result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function getPreferredRemote(repoPath: string): Promise<string | undefined> {
  const result = await runCommand("git", ["-C", repoPath, "remote"]);
  if (!result.stdout) {
    return undefined;
  }

  const remotes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (remotes.includes("origin")) {
    return "origin";
  }

  return remotes[0];
}

export async function getRemoteUrl(repoPath: string, remoteName: string): Promise<string | undefined> {
  try {
    const result = await runCommand("git", ["-C", repoPath, "remote", "get-url", remoteName]);
    return result.stdout || undefined;
  } catch {
    return undefined;
  }
}

export async function pushBranch(repoPath: string, branchName: string, remoteName: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "push", "--set-upstream", remoteName, branchName]);
}

async function remoteBranchExists(repoPath: string, remoteName: string, branchName: string): Promise<boolean> {
  const result = await runCommand("git", ["-C", repoPath, "ls-remote", "--heads", remoteName, branchName]);
  return result.stdout.length > 0;
}

async function refreshRemoteTrackingBranch(repoPath: string, remoteName: string, branchName: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "fetch", remoteName, `refs/heads/${branchName}:refs/remotes/${remoteName}/${branchName}`]);
}

export async function commitAllChanges(repoPath: string, message: string): Promise<boolean> {
  if (!(await isWorkingTreeDirty(repoPath))) {
    return false;
  }

  await runCommand("git", ["-C", repoPath, "add", "-A"]);
  await runCommand("git", ["-C", repoPath, "commit", "-m", message]);
  return true;
}

export async function fileExistsInGitDir(repoPath: string, relativeGitPath: string): Promise<boolean> {
  try {
    await runCommand("git", ["-C", repoPath, "rev-parse", "--git-path", relativeGitPath]);
    const resolved = await runCommand("git", ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-path", relativeGitPath]);
    const targetPath = resolved.stdout;
    const { access } = await import("node:fs/promises");
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function isMergeInProgress(repoPath: string): Promise<boolean> {
  return fileExistsInGitDir(repoPath, "MERGE_HEAD");
}

export async function continueMerge(repoPath: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "merge", "--continue"], {
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no"
    }
  });
}

export async function createMergeWorktree(
  repoPath: string,
  workspacePath: string,
  mergeBranchName: string,
  baseBranch: string
): Promise<void> {
  await ensureDirectory(path.dirname(workspacePath));
  await createWorktree(repoPath, workspacePath, mergeBranchName, baseBranch);
}

export async function mergeBranchIntoCurrent(repoPath: string, branchName: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "merge", "--no-ff", "--no-edit", branchName]);
}

export async function abortMerge(repoPath: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "merge", "--abort"]);
}

export async function listConflictedFiles(repoPath: string): Promise<string[]> {
  const result = await runCommand("git", ["-C", repoPath, "diff", "--name-only", "--diff-filter=U"]);
  if (!result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function stageFiles(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  await runCommand("git", ["-C", repoPath, "add", "--", ...files]);
}

export async function stageAllChanges(repoPath: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "add", "-A"]);
}

export async function getBranchPushStatus(
  repoPath: string,
  branchName: string,
  remoteName?: string
): Promise<{ remoteBranchName?: string; existsRemotely: boolean; pushStatus: PushStatus; aheadBy: number; behindBy: number }> {
  if (!remoteName) {
    return {
      existsRemotely: false,
      pushStatus: "no-remote",
      aheadBy: 0,
      behindBy: 0
    };
  }

  const remoteBranchName = `${remoteName}/${branchName}`;
  try {
    const existsRemotely = await remoteBranchExists(repoPath, remoteName, branchName);
    if (!existsRemotely) {
      return {
        remoteBranchName,
        existsRemotely: false,
        pushStatus: "branch-not-pushed",
        aheadBy: 0,
        behindBy: 0
      };
    }

    await refreshRemoteTrackingBranch(repoPath, remoteName, branchName);
  } catch {
    return {
      remoteBranchName,
      existsRemotely: false,
      pushStatus: "branch-not-pushed",
      aheadBy: 0,
      behindBy: 0
    };
  }

  try {
    const result = await runCommand("git", ["-C", repoPath, "rev-list", "--left-right", "--count", `${branchName}...${remoteBranchName}`]);
    const [aheadRaw, behindRaw] = result.stdout.split(/\s+/);
    const aheadBy = Number.parseInt(aheadRaw ?? "0", 10);
    const behindBy = Number.parseInt(behindRaw ?? "0", 10);
    let pushStatus: PushStatus = "unknown";
    if (aheadBy === 0 && behindBy === 0) {
      pushStatus = "up-to-date";
    } else if (aheadBy > 0 && behindBy === 0) {
      pushStatus = "ahead-of-remote";
    } else if (aheadBy === 0 && behindBy > 0) {
      pushStatus = "behind-remote";
    } else if (aheadBy > 0 && behindBy > 0) {
      pushStatus = "diverged";
    }

    return {
      remoteBranchName,
      existsRemotely: true,
      pushStatus,
      aheadBy: Number.isNaN(aheadBy) ? 0 : aheadBy,
      behindBy: Number.isNaN(behindBy) ? 0 : behindBy
    };
  } catch {
    return {
      remoteBranchName,
      existsRemotely: true,
      pushStatus: "unknown",
      aheadBy: 0,
      behindBy: 0
    };
  }
}
