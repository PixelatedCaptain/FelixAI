import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ExecutionResult } from "./types.js";
import { resolveSpawnTarget, terminateProcessTree } from "./process-utils.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { SandboxMode } from "@openai/codex-sdk";

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

function buildResumedPrompt(prompt: string): string {
  return [
    "Continue the existing FelixAI session.",
    "Return only a JSON object with keys: status, summary, nextPrompt.",
    "Allowed status values: completed, needs_resume, blocked.",
    "Use nextPrompt=null unless another same-session continuation is required.",
    "",
    prompt
  ].join("\n");
}

export async function runCodexCliIssueSession(options: {
  prompt: string;
  workspacePath: string;
  sessionId?: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  sandboxMode?: SandboxMode;
  networkAccessEnabled?: boolean;
  onSessionReady?: (sessionId: string) => Promise<void> | void;
}): Promise<ExecutionResult> {
  const schemaDir = await mkdtemp(path.join(os.tmpdir(), "felix-codex-schema-"));
  const schemaPath = path.join(schemaDir, "execution-schema.json");
  await writeFile(schemaPath, `${JSON.stringify(EXECUTION_SCHEMA, null, 2)}\n`, "utf8");

  const args = options.sessionId
    ? ["exec", "resume", options.sessionId]
    : ["exec", "--output-schema", schemaPath, "-C", options.workspacePath];
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.modelReasoningEffort}"`);
  }
  if (!options.sessionId && options.sandboxMode) {
    args.push("-s", options.sandboxMode);
  }
  if (options.networkAccessEnabled) {
    args.push("--search");
  }
  args.push("--json", "-");

  try {
    return await new Promise<ExecutionResult>((resolve, reject) => {
      const env = { ...process.env, OPENAI_API_KEY: "" };
      void (async () => {
        const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";
        const target = await resolveSpawnTarget(codexCommand, args, env);
        const child = spawn(target.command, target.args, {
          cwd: options.workspacePath,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false
        });

        let stdoutBuffer = "";
        let stderr = "";
        let lastAgentMessage = "";
        let parsedTerminalResult: ExecutionResult | undefined;
        let settled = false;
        let terminateTimer: NodeJS.Timeout | undefined;
        const telemetry = {
          promptChars: options.prompt.length,
          promptLines: options.prompt.split(/\r?\n/).length,
          transcriptEventCount: 0,
          toolCallCount: 0,
          toolOutputCount: 0,
          reasoningCount: 0
        };

        const finalize = (result: ExecutionResult): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (terminateTimer) {
            clearTimeout(terminateTimer);
            terminateTimer = undefined;
          }
          child.stdout.removeAllListeners("data");
          child.stderr.removeAllListeners("data");
          void (async () => {
            await terminateProcessTree(child.pid);
            resolve({
              ...result,
              telemetry: {
                promptChars: telemetry.promptChars,
                promptLines: telemetry.promptLines,
                transcriptEventCount: telemetry.transcriptEventCount,
                toolCallCount: telemetry.toolCallCount,
                toolOutputCount: telemetry.toolOutputCount,
                reasoningCount: telemetry.reasoningCount
              }
            });
          })().catch(reject);
        };

        const fail = (error: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (terminateTimer) {
            clearTimeout(terminateTimer);
            terminateTimer = undefined;
          }
          reject(error);
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdin.setDefaultEncoding("utf8");
        child.stdin.end(options.sessionId ? buildResumedPrompt(options.prompt) : options.prompt);

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
              telemetry.transcriptEventCount += 1;
              if (event.type === "thread.started" && event.thread_id) {
                void options.onSessionReady?.(event.thread_id);
              }
              if (event.type === "item.completed" && event.item?.type === "reasoning") {
                telemetry.reasoningCount += 1;
              }
              if (event.type === "item.completed" && event.item?.type === "function_call") {
                telemetry.toolCallCount += 1;
              }
              if (event.type === "item.completed" && event.item?.type === "function_call_output") {
                telemetry.toolOutputCount += 1;
              }
              if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
                lastAgentMessage = event.item.text;
                try {
                  parsedTerminalResult = parseExecutionResult(event.item.text);
                } catch {
                  parsedTerminalResult = undefined;
                }
              }
              if (event.type === "task_complete" && parsedTerminalResult) {
                finalize(parsedTerminalResult);
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
          fail(error);
        });

        child.on("close", (code) => {
          if (settled) {
            return;
          }
          if (code !== 0) {
            fail(new Error(stderr.trim() || `codex exec exited with code ${code ?? "unknown"}.`));
            return;
          }

          if (parsedTerminalResult) {
            finalize(parsedTerminalResult);
            return;
          }

          if (!lastAgentMessage) {
            fail(new Error("codex exec completed without a structured final agent message."));
            return;
          }

          try {
            finalize(parseExecutionResult(lastAgentMessage));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });

        terminateTimer = setTimeout(() => {
          if (!settled && parsedTerminalResult && !child.killed) {
            void terminateProcessTree(child.pid);
          }
        }, 2_000);
      })().catch(reject);
    });
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }
}
