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
  executionMetadata?: GitHubIssueExecutionMetadata;
}

export type GitHubIssueExecutionLane = "ready-parallel" | "ordered" | "blocked";

export interface GitHubIssueExecutionMetadata {
  lane: GitHubIssueExecutionLane;
  dependsOn: number[];
  parallelSafe: boolean;
  doneChecklistCount: number;
  doneChecklistCompletedCount: number;
  validationErrors: string[];
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

function extractMarkdownSection(body: string | undefined, heading: string): string | undefined {
  if (!body) {
    return undefined;
  }

  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^##\\s+${escapedHeading}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, "im"));
  return match?.[1]?.trim();
}

function parseDependsOnValue(section: string | undefined): number[] {
  if (!section) {
    return [];
  }

  const match = section.match(/^\s*-\s*Depends on:\s*(.+)$/im);
  if (!match?.[1]) {
    return [];
  }

  const raw = match[1].trim();
  if (/^none$/i.test(raw)) {
    return [];
  }

  return [...raw.matchAll(/#(\d+)/g)]
    .map((entry) => Number.parseInt(entry[1] ?? "", 10))
    .filter((value) => Number.isInteger(value));
}

function parseLaneValue(section: string | undefined, labels: string[]): GitHubIssueExecutionLane | undefined {
  const explicit = section?.match(/^\s*-\s*Lane:\s*(.+)$/im)?.[1]?.trim().toLowerCase();
  if (explicit === "ready-parallel" || explicit === "ordered" || explicit === "blocked") {
    return explicit;
  }

  if (labels.includes("ready-parallel")) {
    return "ready-parallel";
  }
  if (labels.includes("ordered")) {
    return "ordered";
  }
  if (labels.includes("blocked")) {
    return "blocked";
  }

  return undefined;
}

function parseParallelSafeValue(section: string | undefined, lane: GitHubIssueExecutionLane | undefined): boolean | undefined {
  const explicit = section?.match(/^\s*-\s*Parallel-safe:\s*(.+)$/im)?.[1]?.trim().toLowerCase();
  if (["yes", "true"].includes(explicit ?? "")) {
    return true;
  }
  if (["no", "false"].includes(explicit ?? "")) {
    return false;
  }

  if (lane === "ready-parallel") {
    return true;
  }
  if (lane === "ordered" || lane === "blocked") {
    return false;
  }

  return undefined;
}

function parseDoneChecklist(section: string | undefined): { total: number; completed: number } {
  if (!section) {
    return { total: 0, completed: 0 };
  }

  const items = [...section.matchAll(/^\s*-\s*\[( |x|X)\]\s+.+$/gm)];
  return {
    total: items.length,
    completed: items.filter((item) => (item[1] ?? "").toLowerCase() === "x").length
  };
}

export function parseGitHubIssueExecutionMetadata(body: string | undefined, labels: string[]): GitHubIssueExecutionMetadata {
  const executionSection = extractMarkdownSection(body, "Execution Metadata");
  const doneCriteriaSection = extractMarkdownSection(body, "Done Criteria");
  const lane = parseLaneValue(executionSection, labels);
  const dependsOn = parseDependsOnValue(executionSection);
  const parallelSafe = parseParallelSafeValue(executionSection, lane);
  const doneChecklist = parseDoneChecklist(doneCriteriaSection);
  const validationErrors: string[] = [];

  if (!executionSection) {
    validationErrors.push("Missing required '## Execution Metadata' section.");
  }
  if (!lane) {
    validationErrors.push("Missing or invalid 'Lane' value.");
  }
  if (parallelSafe === undefined) {
    validationErrors.push("Missing or invalid 'Parallel-safe' value.");
  }
  if (!doneCriteriaSection) {
    validationErrors.push("Missing required '## Done Criteria' section.");
  }

  return {
    lane: lane ?? "ordered",
    dependsOn,
    parallelSafe: parallelSafe ?? false,
    doneChecklistCount: doneChecklist.total,
    doneChecklistCompletedCount: doneChecklist.completed,
    validationErrors
  };
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
      url: issue.url,
      executionMetadata: parseGitHubIssueExecutionMetadata(
        issue.body?.trim() || undefined,
        (issue.labels ?? []).map((label) => label.name?.trim()).filter((value): value is string => Boolean(value))
      )
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

export async function fetchGitHubIssue(repoRoot: string, issueNumber: number): Promise<GitHubIssueRecord> {
  const result = await runGitHubCli(repoRoot, [
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "id,number,title,body,labels,state,assignees,updatedAt,url"
  ]);

  const parsed = JSON.parse(result.stdout) as RawIssue;
  const normalized = normalizeGitHubIssues([parsed]);
  if (normalized.length === 0) {
    throw new Error(`GitHub issue #${issueNumber} could not be loaded.`);
  }

  return normalized[0] as GitHubIssueRecord;
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
