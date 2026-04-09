import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadOptions } from "@openai/codex-sdk";

import { buildExecutionPolicyInstructions } from "./repo-agents.js";
import type { FelixConfig } from "./types.js";
import type { GitHubIssueSnapshotItem } from "./issue-planner.js";

export interface IssueLabelDefinition {
  name: string;
  description: string;
  color: string;
}

export interface IssueLabelAssignment {
  issueNumber: number;
  title: string;
  labels: string[];
  reasoning: string;
}

export interface IssueLabelingResult {
  summary: string;
  labels: IssueLabelDefinition[];
  assignments: IssueLabelAssignment[];
}

const ISSUE_LABELING_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          color: { type: "string" }
        },
        required: ["name", "description", "color"],
        additionalProperties: false
      }
    },
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueNumber: { type: "number" },
          title: { type: "string" },
          labels: {
            type: "array",
            items: { type: "string" }
          },
          reasoning: { type: "string" }
        },
        required: ["issueNumber", "title", "labels", "reasoning"],
        additionalProperties: false
      }
    }
  },
  required: ["summary", "labels", "assignments"],
  additionalProperties: false
} as const;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function buildIssueLabelingPrompt(input: {
  directive: string;
  repoRoot: string;
  issues: GitHubIssueSnapshotItem[];
  turboMode?: boolean;
  encourageSubagents?: boolean;
}): string {
  const executionPolicy = buildExecutionPolicyInstructions(input);
  return [
    "You are the GitHub issue labeling session for FelixAI Orchestrator.",
    "Review the unfinished GitHub issues and decide which labels Felix should apply.",
    "Return a compact label set and an assignment entry for every issue in the provided list.",
    "Prefer concise kebab-case label names.",
    "Use empty labels only when an issue clearly should not receive any of the labels you define.",
    "Keep reasoning concise and specific.",
    ...executionPolicy,
    `Repository root: ${input.repoRoot}`,
    `Operator directive: ${input.directive}`,
    "Issues JSON:",
    JSON.stringify(input.issues, null, 2)
  ].join("\n\n");
}

export function validateIssueLabelingResult(
  result: IssueLabelingResult,
  issues: GitHubIssueSnapshotItem[]
): IssueLabelingResult {
  if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
    throw new Error("Issue labeling result must include a non-empty summary.");
  }

  const labelNames = new Set<string>();
  for (const label of result.labels) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label.name)) {
      throw new Error(`Issue labeling result returned invalid label name '${label.name}'.`);
    }
    if (!/^[0-9a-fA-F]{6}$/.test(label.color)) {
      throw new Error(`Issue labeling result returned invalid color '${label.color}' for label '${label.name}'.`);
    }
    labelNames.add(label.name);
  }

  const validIssueNumbers = new Set(issues.map((issue) => issue.number));
  const seen = new Set<number>();
  for (const assignment of result.assignments) {
    if (!validIssueNumbers.has(assignment.issueNumber)) {
      throw new Error(`Issue labeling result referenced unknown issue #${assignment.issueNumber}.`);
    }
    if (seen.has(assignment.issueNumber)) {
      throw new Error(`Issue labeling result referenced duplicate issue #${assignment.issueNumber}.`);
    }
    seen.add(assignment.issueNumber);
    for (const label of assignment.labels) {
      if (!labelNames.has(label)) {
        throw new Error(`Issue labeling result referenced undefined label '${label}' on issue #${assignment.issueNumber}.`);
      }
    }
  }

  if (seen.size !== validIssueNumbers.size) {
    const missing = [...validIssueNumbers].filter((issueNumber) => !seen.has(issueNumber));
    throw new Error(`Issue labeling result omitted issues: ${missing.map((issueNumber) => `#${issueNumber}`).join(", ")}`);
  }

  return result;
}

export class IssueLabeler {
  private readonly codex: Codex;

  constructor(private readonly config: FelixConfig) {
    this.codex = new Codex(this.getCodexOptions());
  }

  async createLabelingPlan(input: {
    directive: string;
    repoRoot: string;
    issues: GitHubIssueSnapshotItem[];
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
  }): Promise<{ sessionId?: string; result: IssueLabelingResult }> {
    const thread = this.codex.startThread(this.getThreadOptions(input.repoRoot, input));
    const turn = await thread.run(buildIssueLabelingPrompt(input), { outputSchema: ISSUE_LABELING_SCHEMA });
    return {
      sessionId: thread.id ?? undefined,
      result: validateIssueLabelingResult(parseJson<IssueLabelingResult>(turn.finalResponse), input.issues)
    };
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
