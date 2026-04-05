import { runCommand } from "./process-utils.js";

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

export async function createWorktree(repoPath: string, workspacePath: string, branchName: string, baseBranch: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "worktree", "add", "-b", branchName, workspacePath, baseBranch]);
}
