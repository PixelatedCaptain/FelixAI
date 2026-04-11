import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ExecutionResult } from "./types.js";
import { resolveSpawnTarget } from "./process-utils.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

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

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

function parseExecutionResult(raw: string): ExecutionResult {
  const parsed = JSON.parse(raw) as {
    status: ExecutionResult["status"];
    summary: string;
    nextPrompt?: string | null;
  };
  return {
    status: parsed.status,
    summary: parsed.summary,
    nextPrompt: parsed.nextPrompt ?? undefined
  };
}

export async function runCodexCliIssueSession(options: {
  prompt: string;
  workspacePath: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  onSessionReady?: (sessionId: string) => Promise<void> | void;
}): Promise<ExecutionResult> {
  const schemaDir = await mkdtemp(path.join(os.tmpdir(), "felix-codex-schema-"));
  const schemaPath = path.join(schemaDir, "execution-schema.json");
  await writeFile(schemaPath, `${JSON.stringify(EXECUTION_SCHEMA, null, 2)}\n`, "utf8");

  const args = ["exec", "--json", "--output-schema", schemaPath, "-C", options.workspacePath];
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.modelReasoningEffort}"`);
  }
  args.push(options.prompt);

  try {
    return await new Promise<ExecutionResult>((resolve, reject) => {
      const env = { ...process.env, OPENAI_API_KEY: "" };
      void (async () => {
        const target = await resolveSpawnTarget("codex", args, env);
        const child = spawn(target.command, target.args, {
          cwd: options.workspacePath,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false
        });

        let stdoutBuffer = "";
        let stderr = "";
        let lastAgentMessage = "";

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk: string) => {
          stdoutBuffer += chunk;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            try {
              const event = JSON.parse(trimmed) as CodexJsonEvent;
              if (event.type === "thread.started" && event.thread_id) {
                void options.onSessionReady?.(event.thread_id);
              }
              if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
                lastAgentMessage = event.item.text;
              }
            } catch {
              // Ignore non-JSON noise; only structured events matter here.
            }
          }
        });

        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });

        child.on("error", (error) => {
          reject(error);
        });

        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `codex exec exited with code ${code ?? "unknown"}.`));
            return;
          }

          if (!lastAgentMessage) {
            reject(new Error("codex exec completed without a structured final agent message."));
            return;
          }

          try {
            resolve(parseExecutionResult(lastAgentMessage));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      })().catch(reject);
    });
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }
}
