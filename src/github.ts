import { runCommand } from "./process-utils.js";

function normalizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl.trim().replace(/\.git$/, "");
}

export function buildCompareUrl(remoteUrl: string, baseBranch: string, headBranch: string): string | undefined {
  const normalized = normalizeRemoteUrl(remoteUrl);
  if (!/github\.com[:/]/i.test(normalized)) {
    return undefined;
  }

  if (normalized.startsWith("git@github.com:")) {
    const repo = normalized.slice("git@github.com:".length);
    return `https://github.com/${repo}/compare/${baseBranch}...${encodeURIComponent(headBranch)}?expand=1`;
  }

  if (normalized.startsWith("https://github.com/")) {
    return `${normalized}/compare/${baseBranch}...${encodeURIComponent(headBranch)}?expand=1`;
  }

  return undefined;
}

export async function createPullRequest(options: {
  repoPath: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<{ number?: number; url?: string; status: "draft" | "open" }> {
  const args = [
    "pr",
    "create",
    "--base",
    options.baseBranch,
    "--head",
    options.headBranch,
    "--title",
    options.title,
    "--body",
    options.body
  ];
  if (options.draft) {
    args.push("--draft");
  }

  const result = await runCommand("gh", args, { cwd: options.repoPath });
  const url = result.stdout.split(/\r?\n/).find((line) => /^https:\/\/github\.com\//i.test(line.trim()))?.trim();
  const numberMatch = url?.match(/\/pull\/(\d+)$/);
  return {
    number: numberMatch ? Number.parseInt(numberMatch[1], 10) : undefined,
    url,
    status: options.draft ? "draft" : "open"
  };
}
