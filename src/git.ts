import { runCommand } from "./process-utils.js";
import type { PushStatus } from "./types.js";

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
    await runCommand("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/remotes/${remoteBranchName}`]);
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
