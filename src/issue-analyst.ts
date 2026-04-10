import { CodexAdapter } from "./codex-adapter.js";
import type { FelixConfig } from "./types.js";
import type { GitHubIssueSnapshotItem } from "./issue-planner.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { PriorIssueAnalysisContext } from "./intent-parser.js";

export interface IssueAnalysisResult {
  summary: string;
  recommendedIssueNumbers: number[];
  implementationIssueNumbers: number[];
  isImplementationPlan: boolean;
  requiresConfirmation: boolean;
}

const ISSUE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    recommendedIssueNumbers: {
      type: "array",
      items: { type: "number" }
    },
    implementationIssueNumbers: {
      type: "array",
      items: { type: "number" }
    },
    isImplementationPlan: {
      type: "boolean"
    },
    requiresConfirmation: {
      type: "boolean"
    }
  },
  required: ["summary", "recommendedIssueNumbers", "implementationIssueNumbers", "isImplementationPlan", "requiresConfirmation"],
  additionalProperties: false
} as const;

function buildIssueAnalysisPrompt(input: {
  directive: string;
  repoRoot: string;
  issues: GitHubIssueSnapshotItem[];
  topN?: number;
  priorIssueAnalysis?: PriorIssueAnalysisContext;
}): string {
  return [
    "You are the GitHub issue analysis session for FelixAI Orchestrator.",
    "Answer the user's question about the current GitHub issues.",
    "When the user asks for recommendations or prioritization, rank the strongest issues first in recommendedIssueNumbers.",
    "Only include issue numbers present in the provided issue list.",
    "Separately decide whether your answer is an actionable implementation plan. Set isImplementationPlan=true only when your answer identifies a concrete issue set Felix could start implementing next.",
    "Set implementationIssueNumbers to the issue numbers Felix should implement if the operator confirms. If the user refers to prior analysis with phrases like 'the first one' or 'them', resolve that using the provided prior issue analysis context.",
    "Set requiresConfirmation=true whenever implementation should only proceed after an explicit operator confirmation.",
    input.topN ? `The user asked for a bounded result set; keep the recommendation list to at most ${input.topN} issues.` : undefined,
    `Repository root: ${input.repoRoot}`,
    `Operator directive: ${input.directive}`,
    input.priorIssueAnalysis
      ? `Prior issue analysis context:\n${JSON.stringify(input.priorIssueAnalysis, null, 2)}`
      : "Prior issue analysis context: none",
    "Issues JSON:",
    JSON.stringify(input.issues, null, 2)
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

function normalizeAnalysis(
  result: IssueAnalysisResult,
  issues: GitHubIssueSnapshotItem[],
  topN?: number
): IssueAnalysisResult {
  const valid = new Set(issues.map((issue) => issue.number));
  const recommendedIssueNumbers = [...new Set(result.recommendedIssueNumbers.filter((value) => valid.has(value)))];
  const implementationIssueNumbers = [...new Set(result.implementationIssueNumbers.filter((value) => valid.has(value)))];
  return {
    summary: result.summary.trim(),
    recommendedIssueNumbers: topN ? recommendedIssueNumbers.slice(0, topN) : recommendedIssueNumbers,
    implementationIssueNumbers,
    isImplementationPlan: result.isImplementationPlan && implementationIssueNumbers.length > 0,
    requiresConfirmation: result.requiresConfirmation
  };
}

export class IssueAnalyst {
  private readonly adapter: CodexAdapter;

  constructor(config: FelixConfig) {
    this.adapter = new CodexAdapter(config);
  }

  async analyze(input: {
    directive: string;
    repoRoot: string;
    issues: GitHubIssueSnapshotItem[];
    topN?: number;
    priorIssueAnalysis?: PriorIssueAnalysisContext;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
  }): Promise<{ sessionId?: string; result: IssueAnalysisResult }> {
    const response = await this.adapter.runStructuredPrompt<IssueAnalysisResult>({
      prompt: buildIssueAnalysisPrompt(input),
      workspacePath: input.repoRoot,
      outputSchema: ISSUE_ANALYSIS_SCHEMA,
      model: input.model,
      modelReasoningEffort: input.modelReasoningEffort,
      turboMode: input.turboMode,
      encourageSubagents: input.encourageSubagents
    });

    return {
      sessionId: response.sessionId,
      result: normalizeAnalysis(response.result, input.issues, input.topN)
    };
  }
}
