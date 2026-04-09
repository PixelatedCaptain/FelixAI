import { runGitHubCli } from "./github.js";
import { saveIssueSnapshot } from "./issue-state.js";

export interface GitHubIssueRecord {
  id: string;
  number: number;
  title: string;
  body?: string;
  bodySummary?: string;
  labels: string[];
  assignees: string[];
  state: string;
  updatedAt: string;
  url: string;
}

export interface GitHubIssueSnapshotRecord {
  repoRoot: string;
  generatedAt: string;
  issues: GitHubIssueRecord[];
}

interface RawIssue {
  id?: string;
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  updatedAt?: string;
  url?: string;
  labels?: { name?: string }[];
  assignees?: { login?: string }[];
}

function summarizeBody(body: string | undefined): string | undefined {
  if (!body) {
    return undefined;
  }

  const normalized = body.replace(/\r/g, "").trim();
  if (!normalized) {
    return undefined;
  }

  const firstParagraph = normalized.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
  if (!firstParagraph) {
    return undefined;
  }

  return firstParagraph.length > 280 ? `${firstParagraph.slice(0, 277)}...` : firstParagraph;
}

export function normalizeGitHubIssues(rawIssues: RawIssue[]): GitHubIssueRecord[] {
  return rawIssues
    .filter((issue): issue is Required<Pick<RawIssue, "id" | "number" | "title" | "state" | "updatedAt" | "url">> & RawIssue => {
      return (
        typeof issue.id === "string" &&
        typeof issue.number === "number" &&
        typeof issue.title === "string" &&
        typeof issue.state === "string" &&
        typeof issue.updatedAt === "string" &&
        typeof issue.url === "string"
      );
    })
    .map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title.trim(),
      body: issue.body?.trim() || undefined,
      bodySummary: summarizeBody(issue.body),
      labels: (issue.labels ?? []).map((label) => label.name?.trim()).filter((value): value is string => Boolean(value)),
      assignees: (issue.assignees ?? []).map((assignee) => assignee.login?.trim()).filter((value): value is string => Boolean(value)),
      state: issue.state,
      updatedAt: issue.updatedAt,
      url: issue.url
    }))
    .sort((left, right) => left.number - right.number);
}

export async function fetchUnfinishedGitHubIssues(repoRoot: string): Promise<GitHubIssueRecord[]> {
  const result = await runGitHubCli(repoRoot, [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "id,number,title,body,labels,state,assignees,updatedAt,url"
  ]
  );

  const parsed = JSON.parse(result.stdout) as RawIssue[];
  return normalizeGitHubIssues(parsed);
}

export async function snapshotUnfinishedGitHubIssues(
  projectRoot: string,
  repoRoot: string,
  options?: { fetchIssues?: (repoRoot: string) => Promise<GitHubIssueRecord[]> }
): Promise<{
  snapshot: GitHubIssueSnapshotRecord;
  outputPath: string;
}> {
  const snapshot: GitHubIssueSnapshotRecord = {
    repoRoot,
    generatedAt: new Date().toISOString(),
    issues: await (options?.fetchIssues ?? fetchUnfinishedGitHubIssues)(repoRoot)
  };

  const outputPath = await saveIssueSnapshot(projectRoot, repoRoot, snapshot);
  return {
    snapshot,
    outputPath
  };
}
