import { runCommand } from "./process-utils.js";

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
