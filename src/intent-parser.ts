import { CodexAdapter } from "./codex-adapter.js";
import type { FelixConfig } from "./types.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

export type FelixIntentMode = "repo_prompt" | "issue_analysis" | "issue_labeling" | "issue_execution";

export interface ParsedFelixIntent {
  mode: FelixIntentMode;
  issueNumbers: number[];
  labelFilters: string[];
  topN?: number;
  implementFirstOnly: boolean;
  requiresConfirmation: boolean;
  reasoning: string;
}

export interface PriorIssueAnalysisContext {
  summary: string;
  recommendedIssueNumbers: number[];
  filteredIssueNumbers: number[];
}

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["repo_prompt", "issue_analysis", "issue_labeling", "issue_execution"]
    },
    issueNumbers: {
      type: "array",
      items: { type: "number" }
    },
    labelFilters: {
      type: "array",
      items: { type: "string" }
    },
    topN: {
      type: ["number", "null"]
    },
    implementFirstOnly: {
      type: "boolean"
    },
    requiresConfirmation: {
      type: "boolean"
    },
    reasoning: {
      type: "string"
    }
  },
  required: ["mode", "issueNumbers", "labelFilters", "topN", "implementFirstOnly", "requiresConfirmation", "reasoning"],
  additionalProperties: false
} as const;

function normalizeIntent(intent: ParsedFelixIntent): ParsedFelixIntent {
  return {
    ...intent,
    issueNumbers: [...new Set(intent.issueNumbers.filter((value) => Number.isInteger(value)))],
    labelFilters: [...new Set(intent.labelFilters.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))],
    topN: intent.topN && Number.isInteger(intent.topN) && intent.topN > 0 ? intent.topN : undefined,
    reasoning: intent.reasoning.trim()
  };
}

function buildIntentPrompt(input: {
  userPrompt: string;
  repoRoot: string;
  issueSnapshot?: Array<{ number: number; title: string; labels: string[] }>;
  priorIssueAnalysis?: PriorIssueAnalysisContext;
}): string {
  return [
    "You are the FelixAI intent parser.",
    "Interpret the user's request and return only the structured intent JSON.",
    "Use mode=issue_analysis when the user is asking for information, ranking, recommendations, counts, or prioritization about GitHub issues without asking Felix to start implementation.",
    "Use mode=issue_execution when the user is asking Felix to implement, process, work through, or start on GitHub issues.",
    "Use mode=issue_labeling only when the user explicitly wants labels created, applied, or changed on GitHub issues.",
    "Use mode=repo_prompt for all other repo-aware requests.",
    "If the user refers to a prior issue-analysis result with words like 'the first one', 'that one', 'those issues', or 'that plan', resolve that reference using the provided prior issue analysis context.",
    "Set requiresConfirmation=true when the request mixes planning/prioritization language with implementation language in one prompt.",
    "Set implementFirstOnly=true only when the user explicitly wants just the first issue from a filtered or prioritized set implemented.",
    "Fill issueNumbers with the resolved issue numbers when the user names them directly or refers to prior issue-analysis results.",
    "Fill labelFilters with explicit GitHub issue labels requested by the user, such as 'app-ready'.",
    "Use topN when the user asks for a bounded count such as top 3.",
    `Repository root: ${input.repoRoot}`,
    input.priorIssueAnalysis
      ? `Prior issue analysis context:\n${JSON.stringify(input.priorIssueAnalysis, null, 2)}`
      : "Prior issue analysis context: none",
    input.issueSnapshot
      ? `Current issue snapshot summary:\n${JSON.stringify(input.issueSnapshot, null, 2)}`
      : "Current issue snapshot summary: none",
    `User prompt: ${input.userPrompt}`
  ].join("\n\n");
}

export class IntentParser {
  private readonly adapter: CodexAdapter;

  constructor(config: FelixConfig) {
    this.adapter = new CodexAdapter(config);
  }

  async parse(input: {
    userPrompt: string;
    repoRoot: string;
    issueSnapshot?: Array<{ number: number; title: string; labels: string[] }>;
    priorIssueAnalysis?: PriorIssueAnalysisContext;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
  }): Promise<{ sessionId?: string; intent: ParsedFelixIntent }> {
    const result = await this.adapter.runStructuredPrompt<ParsedFelixIntent>({
      prompt: buildIntentPrompt(input),
      workspacePath: input.repoRoot,
      outputSchema: INTENT_SCHEMA,
      model: input.model,
      modelReasoningEffort: input.modelReasoningEffort,
      turboMode: input.turboMode,
      encourageSubagents: input.encourageSubagents
    });

    return {
      sessionId: result.sessionId,
      intent: normalizeIntent(result.result)
    };
  }
}
