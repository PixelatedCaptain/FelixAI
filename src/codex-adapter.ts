import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadOptions } from "@openai/codex-sdk";

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

export class CodexAdapter {
  private readonly codex: Codex;

  constructor(private readonly config: FelixConfig) {
    this.codex = new Codex(this.getCodexOptions());
  }

  async createPlan(
    task: string,
    repoRoot: string,
    baseBranch: string,
    runtimePreferences?: { model?: string; modelReasoningEffort?: ModelReasoningEffort }
  ): Promise<PlanResult> {
    const thread = this.codex.startThread(this.getThreadOptions(repoRoot, runtimePreferences));
    const prompt = buildPlanningPrompt(task, baseBranch);
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
  }): Promise<ExecutionResult> {
    const thread = options.sessionId
      ? this.codex.resumeThread(
          options.sessionId,
          this.getThreadOptions(options.workspacePath, {
            model: options.model,
            modelReasoningEffort: options.modelReasoningEffort
          })
        )
      : this.codex.startThread(
          this.getThreadOptions(options.workspacePath, {
            model: options.model,
            modelReasoningEffort: options.modelReasoningEffort
          })
        );

    const input = options.resumePrompt ?? [
      "You are executing one FelixAI work item in an isolated Git workspace.",
      "Complete the assigned implementation if possible.",
      "If you hit a boundary and should continue in the same session, return status=needs_resume.",
      "If human review or a blocker is required, return status=blocked.",
      "Return a concise summary.",
      `Work item prompt: ${options.prompt}`
    ].join("\n\n");

    const turn = await thread.run(input, { outputSchema: EXECUTION_SCHEMA });
    const result = normalizeExecutionResult(parseJson<ExecutionResult>(turn.finalResponse));
    return {
      ...result,
      sessionId: thread.id ?? options.sessionId
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
    // Force the SDK to use the local Codex session instead of any ambient API-key auth.
    return {
      env: {
        OPENAI_API_KEY: ""
      }
    };
  }
}
