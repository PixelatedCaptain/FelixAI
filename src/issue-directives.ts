const RESERVED_COMMANDS = new Set(["init", "auth", "doctor", "config", "issues", "version", "job"]);

export function looksLikeIssueLabelingDirective(command: string, rest: string[]): boolean {
  const normalized = [command, ...rest].join(" ").trim().toLowerCase();
  const mentionsIssues = /github issue|github issues|open issues|unfinished issues|issues that are not done|not done issues/.test(normalized);
  const mentionsLabels = /label|labels|labeling|classif|app readiness|infrastructure readiness/.test(normalized);
  return mentionsIssues && mentionsLabels;
}

export function looksLikeIssueDrivenDirective(command: string, rest: string[]): boolean {
  const normalized = [command, ...rest].join(" ").trim().toLowerCase();
  const mentionsIssues = /github issue|github issues|open issues|unfinished issues|issues that are not done|not done issues/.test(normalized);
  const executionIntent =
    /process|implement|start processing|start working|work through|complete|execute|queue up|dependency order|implementation order/.test(
      normalized
    );
  const planningToExecute =
    /(plan|prioriti[sz]e|order|sequence|figure out the best order).*(process|implement|start|work through|complete)/.test(normalized);

  return (mentionsIssues && executionIntent) || planningToExecute;
}

export function classifyTopLevelInput(command: string, rest: string[]): "command" | "issue_labels" | "issue" | "repo" {
  if (RESERVED_COMMANDS.has(command)) {
    return "command";
  }

  if (looksLikeIssueLabelingDirective(command, rest)) {
    return "issue_labels";
  }

  return looksLikeIssueDrivenDirective(command, rest) ? "issue" : "repo";
}
