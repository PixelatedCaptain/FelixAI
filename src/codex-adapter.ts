import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";

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
            type: "array",
            items: { type: "string" }
          },
          dependsOn: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["id", "title", "prompt", "dependsOn"],
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
    nextPrompt: { type: "string" }
  },
  required: ["status", "summary"],
  additionalProperties: false
} as const;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class CodexAdapter {
  private readonly codex: Codex;

  constructor(private readonly config: FelixConfig) {
    this.codex = new Codex(this.getCodexOptions());
  }

  async createPlan(task: string, repoRoot: string, baseBranch: string): Promise<PlanResult> {
    const thread = this.codex.startThread(this.getThreadOptions(repoRoot));
    const prompt = [
      "You are the planning session for FelixAI Orchestrator.",
      "Break the large engineering task into work items that are each reasonable for one Codex session.",
      "Prefer 2-6 work items unless the task is trivial.",
      "Keep dependencies explicit in dependsOn.",
      "If issue references are known, include them in issueRefs as strings like '123' or 'GH-123'.",
      `Base branch: ${baseBranch}.`,
      `Task: ${task}`
    ].join("\n\n");
    const turn = await thread.run(prompt, { outputSchema: PLAN_SCHEMA });
    return parseJson<PlanResult>(turn.finalResponse);
  }

  async executeWorkItem(options: {
    prompt: string;
    workspacePath: string;
    sessionId?: string;
    resumePrompt?: string;
  }): Promise<ExecutionResult> {
    const thread = options.sessionId
      ? this.codex.resumeThread(options.sessionId, this.getThreadOptions(options.workspacePath))
      : this.codex.startThread(this.getThreadOptions(options.workspacePath));

    const input = options.resumePrompt ?? [
      "You are executing one FelixAI work item in an isolated Git workspace.",
      "Complete the assigned implementation if possible.",
      "If you hit a boundary and should continue in the same session, return status=needs_resume.",
      "If human review or a blocker is required, return status=blocked.",
      "Return a concise summary.",
      `Work item prompt: ${options.prompt}`
    ].join("\n\n");

    const turn = await thread.run(input, { outputSchema: EXECUTION_SCHEMA });
    const result = parseJson<ExecutionResult>(turn.finalResponse);
    return {
      ...result,
      sessionId: thread.id ?? options.sessionId
    };
  }

  private getThreadOptions(workingDirectory: string): ThreadOptions {
    return {
      workingDirectory,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandboxMode: this.config.codex.sandboxMode,
      modelReasoningEffort: this.config.codex.modelReasoningEffort,
      webSearchMode: this.config.codex.webSearchMode,
      networkAccessEnabled: this.config.codex.networkAccessEnabled,
      skipGitRepoCheck: false
    };
  }

  private getCodexOptions(): CodexOptions {
    if (this.config.credentialSource === "env-api-key") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("FelixAI is configured for env-api-key credentials, but OPENAI_API_KEY is not set.");
      }

      return {
        apiKey,
        env: {
          OPENAI_API_KEY: apiKey
        }
      };
    }

    // Force the SDK to use the local Codex/ChatGPT session instead of any ambient API key.
    return {
      env: {}
    };
  }
}
