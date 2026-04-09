import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadOptions } from "@openai/codex-sdk";

import { buildExecutionPolicyInstructions } from "./repo-agents.js";
import type { FelixConfig } from "./types.js";

export interface GitHubIssueSnapshotItem {
  number: number;
  nodeId?: string;
  title: string;
  body?: string;
  labels: string[];
  assignees: string[];
  state: string;
  updatedAt: string;
  url: string;
}

export interface GitHubIssueSnapshot {
  repoRoot: string;
  generatedAt: string;
  issues: GitHubIssueSnapshotItem[];
}

export interface IssuePlanningItem {
  issueNumber: number;
  title: string;
  dependsOn: number[];
  parallelSafe: boolean;
  overlapRisk: "low" | "medium" | "high";
  reasoning: string;
}

export interface IssuePlanningResult {
  summary: string;
  orderedIssues: IssuePlanningItem[];
}

const ISSUE_PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    orderedIssues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueNumber: { type: "number" },
          title: { type: "string" },
          dependsOn: {
            type: "array",
            items: { type: "number" }
          },
          parallelSafe: { type: "boolean" },
          overlapRisk: {
            type: "string",
            enum: ["low", "medium", "high"]
          },
          reasoning: { type: "string" }
        },
        required: ["issueNumber", "title", "dependsOn", "parallelSafe", "overlapRisk", "reasoning"],
        additionalProperties: false
      }
    }
  },
  required: ["summary", "orderedIssues"],
  additionalProperties: false
} as const;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function buildIssuePlanningPrompt(input: {
  directive: string;
  repoRoot: string;
  issues: GitHubIssueSnapshotItem[];
  turboMode?: boolean;
  encourageSubagents?: boolean;
}): string {
  const executionPolicy = buildExecutionPolicyInstructions(input);
  return [
    "You are the GitHub issue planning session for FelixAI Orchestrator.",
    "Review the unfinished GitHub issues and return the safest execution order.",
    "Treat each GitHub issue as the preferred unit of work unless an issue is obviously too large or ambiguous.",
    "Use dependsOn only when one issue should clearly wait for another.",
    "Set parallelSafe=true only when the issue can likely run in parallel without overlapping code or behavior.",
    "Use overlapRisk to describe implementation collision risk with neighboring issues.",
    "Keep reasoning concise and specific.",
    ...executionPolicy,
    `Repository root: ${input.repoRoot}`,
    `Operator directive: ${input.directive}`,
    "Issues JSON:",
    JSON.stringify(input.issues, null, 2)
  ].join("\n\n");
}

export function validateIssuePlanningResult(result: IssuePlanningResult, issues: GitHubIssueSnapshotItem[]): IssuePlanningResult {
  if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
    throw new Error("Issue planning result must include a non-empty summary.");
  }

  if (!Array.isArray(result.orderedIssues) || result.orderedIssues.length === 0) {
    throw new Error("Issue planning result must include a non-empty orderedIssues array.");
  }

  const validIssueNumbers = new Set(issues.map((issue) => issue.number));
  const seen = new Set<number>();
  for (const item of result.orderedIssues) {
    if (!validIssueNumbers.has(item.issueNumber)) {
      throw new Error(`Issue planning result referenced unknown issue #${item.issueNumber}.`);
    }
    if (seen.has(item.issueNumber)) {
      throw new Error(`Issue planning result referenced duplicate issue #${item.issueNumber}.`);
    }
    seen.add(item.issueNumber);
    for (const dependency of item.dependsOn) {
      if (!validIssueNumbers.has(dependency)) {
        throw new Error(`Issue planning result referenced missing dependency issue #${dependency}.`);
      }
      if (dependency === item.issueNumber) {
        throw new Error(`Issue #${item.issueNumber} cannot depend on itself.`);
      }
    }
  }

  if (seen.size !== validIssueNumbers.size) {
    const missing = [...validIssueNumbers].filter((issueNumber) => !seen.has(issueNumber));
    throw new Error(`Issue planning result omitted issues: ${missing.map((issueNumber) => `#${issueNumber}`).join(", ")}`);
  }

  return result;
}

export class IssuePlanner {
  private readonly codex: Codex;

  constructor(private readonly config: FelixConfig) {
    this.codex = new Codex(this.getCodexOptions());
  }

  async createIssuePlan(input: {
    directive: string;
    repoRoot: string;
    issues: GitHubIssueSnapshotItem[];
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
  }): Promise<IssuePlanningResult> {
    const thread = this.codex.startThread(this.getThreadOptions(input.repoRoot, input));
    const turn = await thread.run(buildIssuePlanningPrompt(input), { outputSchema: ISSUE_PLAN_SCHEMA });
    return validateIssuePlanningResult(parseJson<IssuePlanningResult>(turn.finalResponse), input.issues);
  }

  private getThreadOptions(
    workingDirectory: string,
    runtimePreferences?: { model?: string; modelReasoningEffort?: ModelReasoningEffort }
  ): ThreadOptions {
    return {
      model: runtimePreferences?.model,
      workingDirectory,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandboxMode: this.config.codex.sandboxMode,
      modelReasoningEffort: runtimePreferences?.modelReasoningEffort ?? this.config.codex.modelReasoningEffort,
      webSearchMode: this.config.codex.webSearchMode,
      networkAccessEnabled: this.config.codex.networkAccessEnabled,
      skipGitRepoCheck: false
    };
  }

  private getCodexOptions(): CodexOptions {
    return {
      env: {
        OPENAI_API_KEY: ""
      }
    };
  }
}
