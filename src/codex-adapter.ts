import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadOptions } from "@openai/codex-sdk";

import { parseRepoAgentsPreferences } from "./repo-agents.js";
import type { ExecutionResult, FelixConfig, PlanResult } from "./types.js";

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    workItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string" },
          issueRefs: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          dependsOn: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["id", "title", "prompt", "issueRefs", "dependsOn"],
        additionalProperties: false
      }
    }
  },
  required: ["summary", "workItems"],
  additionalProperties: false
} as const;

const EXECUTION_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["completed", "needs_resume", "blocked"]
    },
    summary: { type: "string" },
    nextPrompt: { type: ["string", "null"] }
  },
  required: ["status", "summary", "nextPrompt"],
  additionalProperties: false
} as const;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function normalizePlanResult(plan: PlanResult): PlanResult {
  return {
    ...plan,
    workItems: plan.workItems.map((item) => ({
      ...item,
      issueRefs: item.issueRefs ?? []
    }))
  };
}

function normalizeExecutionResult(result: ExecutionResult): ExecutionResult {
  return {
    ...result,
    nextPrompt: result.nextPrompt ?? undefined
  };
}

export function buildPlanningPrompt(task: string, baseBranch: string): string {
  return [
    "You are the planning session for FelixAI Orchestrator.",
    "Break the large engineering task into work items that are each reasonable for one Codex session.",
    "Prefer 2-6 work items unless the task is trivial.",
    "Keep dependencies explicit in dependsOn.",
    "If issue references are known, include them in issueRefs as strings like '123' or 'GH-123'.",
    "Do not create separate verification-only, review-only, or diff-check-only work items when that verification can be done inside the implementation work item.",
    "Only create a separate verification work item when it produces a durable artifact, runs a genuinely independent validation workflow, or the user explicitly asked for a separate validation step.",
    "Avoid no-op work items that would leave their branch with no changes relative to the base branch.",
    `Base branch: ${baseBranch}.`,
    `Task: ${task}`
  ].join("\n\n");
}

interface RuntimeExecutionPreferences {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  turboMode?: boolean;
  encourageSubagents?: boolean;
}

function deriveExecutionPreferences(
  input: string,
  runtimePreferences?: RuntimeExecutionPreferences
): RuntimeExecutionPreferences {
  const repoPreferences = parseRepoAgentsPreferences(input);
  return {
    model: runtimePreferences?.model ?? repoPreferences?.model,
    modelReasoningEffort: runtimePreferences?.modelReasoningEffort ?? repoPreferences?.reasoningEffort,
    turboMode: runtimePreferences?.turboMode ?? repoPreferences?.turboMode,
    encourageSubagents: runtimePreferences?.encourageSubagents ?? repoPreferences?.encourageSubagents
  };
}

function buildExecutionPolicyHint(preferences: RuntimeExecutionPreferences): string | undefined {
  const hints: string[] = [];

  if (preferences.turboMode) {
    hints.push(
      "Repository execution policy: turbo mode is enabled. Prefer decisive progress, keep momentum high, and avoid unnecessary back-and-forth when a safe implementation path is clear."
    );
  }

  if (preferences.encourageSubagents) {
    hints.push(
      "Repository execution policy: subagent use is encouraged when the environment supports it and parallel specialist work will materially speed up planning or execution. Do not spin up subagents for trivial steps."
    );
  }

  return hints.length > 0 ? hints.join("\n") : undefined;
}

function prependExecutionPolicyHint(input: string, preferences?: RuntimeExecutionPreferences): string {
  if (!preferences) {
    return input;
  }

  const hint = buildExecutionPolicyHint(preferences);
  if (!hint) {
    return input;
  }

  return `${hint}\n\n${input}`;
}

export class CodexAdapter {
  private readonly codex: Codex;

  constructor(private readonly config: FelixConfig) {
    this.codex = new Codex(this.getCodexOptions());
  }

  async createPlan(
    task: string,
    repoRoot: string,
    baseBranch: string,
    runtimePreferences?: RuntimeExecutionPreferences
  ): Promise<PlanResult> {
    const executionPreferences = deriveExecutionPreferences(task, runtimePreferences);
    const thread = this.codex.startThread(this.getThreadOptions(repoRoot, executionPreferences));
    const prompt = prependExecutionPolicyHint(buildPlanningPrompt(task, baseBranch), executionPreferences);
    const turn = await thread.run(prompt, { outputSchema: PLAN_SCHEMA });
    return normalizePlanResult(parseJson<PlanResult>(turn.finalResponse));
  }

  async executeWorkItem(options: {
    prompt: string;
    workspacePath: string;
    sessionId?: string;
    resumePrompt?: string;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
    onSessionReady?: (sessionId: string) => Promise<void> | void;
  }): Promise<ExecutionResult> {
    const executionPreferences = deriveExecutionPreferences(options.prompt, {
      model: options.model,
      modelReasoningEffort: options.modelReasoningEffort,
      turboMode: options.turboMode,
      encourageSubagents: options.encourageSubagents
    });
    const thread = options.sessionId
      ? this.codex.resumeThread(
          options.sessionId,
          this.getThreadOptions(options.workspacePath, executionPreferences)
        )
      : this.codex.startThread(this.getThreadOptions(options.workspacePath, executionPreferences));

    if (thread.id) {
      await options.onSessionReady?.(thread.id);
    }

    const input = prependExecutionPolicyHint(
      options.resumePrompt ?? [
        "You are executing one FelixAI work item in an isolated Git workspace.",
        "Complete the assigned implementation if possible.",
        "If you hit a boundary and should continue in the same session, return status=needs_resume.",
        "If human review or a blocker is required, return status=blocked.",
        "Return a concise summary.",
        `Work item prompt: ${options.prompt}`
      ].join("\n\n"),
      deriveExecutionPreferences(options.resumePrompt ?? options.prompt, executionPreferences)
    );

    const turn = await thread.run(input, { outputSchema: EXECUTION_SCHEMA });
    const result = normalizeExecutionResult(parseJson<ExecutionResult>(turn.finalResponse));
    return {
      ...result,
      sessionId: thread.id ?? options.sessionId
    };
  }

  async runPrompt(options: {
    prompt: string;
    workspacePath: string;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
  }): Promise<{ sessionId?: string; response: string }> {
    const executionPreferences = deriveExecutionPreferences(options.prompt, {
      model: options.model,
      modelReasoningEffort: options.modelReasoningEffort,
      turboMode: options.turboMode,
      encourageSubagents: options.encourageSubagents
    });
    const thread = this.codex.startThread(this.getThreadOptions(options.workspacePath, executionPreferences));
    const input = prependExecutionPolicyHint(options.prompt, executionPreferences);
    const turn = await thread.run(input);
    return {
      sessionId: thread.id ?? undefined,
      response: turn.finalResponse
    };
  }

  async runStructuredPrompt<T>(options: {
    prompt: string;
    workspacePath: string;
    outputSchema: object;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
  }): Promise<{ sessionId?: string; result: T }> {
    const executionPreferences = deriveExecutionPreferences(options.prompt, {
      model: options.model,
      modelReasoningEffort: options.modelReasoningEffort,
      turboMode: options.turboMode,
      encourageSubagents: options.encourageSubagents
    });
    const thread = this.codex.startThread(this.getThreadOptions(options.workspacePath, executionPreferences));
    const input = prependExecutionPolicyHint(options.prompt, executionPreferences);
    const turn = await thread.run(input, { outputSchema: options.outputSchema });
    return {
      sessionId: thread.id ?? undefined,
      result: parseJson<T>(turn.finalResponse)
    };
  }

  private getThreadOptions(
    workingDirectory: string,
    runtimePreferences?: RuntimeExecutionPreferences
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
    // Force the SDK to use the local Codex session instead of any ambient API-key auth.
    return {
      env: {
        OPENAI_API_KEY: ""
      }
    };
  }
}
