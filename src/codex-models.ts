import type { FelixConfig } from "./types.js";
import { CodexAdapter } from "./codex-adapter.js";
import type { AuthStatus } from "./auth.js";

export interface CodexModelSupportResult {
  model: string;
  supported: boolean;
  error?: string;
}

export function isUnsupportedCodexModelError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /model.+not supported/i.test(message) || /invalid_request_error/i.test(message);
}

export function getCandidateCodexModels(authStatus?: Pick<AuthStatus, "rawStatus">): string[] {
  const rawStatus = authStatus?.rawStatus?.toLowerCase() ?? "";
  if (rawStatus.includes("logged in using chatgpt")) {
    return ["gpt-5.1-codex-max", "gpt-5.1-codex-mini", "codex-mini-latest", "gpt-5-codex", "gpt-5.2-codex"];
  }

  return ["gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5-codex", "codex-mini-latest"];
}

export async function probeCodexModelSupport(
  config: FelixConfig,
  repoRoot: string,
  model: string
): Promise<CodexModelSupportResult> {
  const adapter = new CodexAdapter(config);
  try {
    await adapter.runPrompt({
      prompt: "Reply with OK.",
      workspacePath: repoRoot,
      model
    });
    return { model, supported: true };
  } catch (error) {
    return {
      model,
      supported: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function discoverSupportedCodexModels(
  config: FelixConfig,
  repoRoot: string,
  authStatus?: Pick<AuthStatus, "rawStatus">
): Promise<CodexModelSupportResult[]> {
  const candidates = getCandidateCodexModels(authStatus);
  const results: CodexModelSupportResult[] = [];

  for (const candidate of candidates) {
    results.push(await probeCodexModelSupport(config, repoRoot, candidate));
  }

  return results;
}
