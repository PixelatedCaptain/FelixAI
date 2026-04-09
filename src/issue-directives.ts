const RESERVED_COMMANDS = new Set(["init", "auth", "doctor", "config", "issues", "version", "job"]);

export function looksLikeIssueDrivenDirective(command: string, rest: string[]): boolean {
  const normalized = [command, ...rest].join(" ").trim().toLowerCase();
  return /github issue|github issues|open issues|unfinished issues|issues that are not done|issue order|process.*issues|review.*issues/.test(
    normalized
  );
}

export function classifyTopLevelInput(command: string, rest: string[]): "command" | "issue" | "repo" {
  if (RESERVED_COMMANDS.has(command)) {
    return "command";
  }

  return looksLikeIssueDrivenDirective(command, rest) ? "issue" : "repo";
}
