const RESERVED_COMMANDS = new Set(["init", "auth", "doctor", "config", "issues", "version", "job"]);

export interface IssueDirectiveScope {
  issueNumbers: number[];
  labelFilters: string[];
  implementFirstOnly: boolean;
}

export function looksLikeIssueLabelingDirective(command: string, rest: string[]): boolean {
  const normalized = [command, ...rest].join(" ").trim().toLowerCase();
  const mentionsIssues = /github issue|github issues|open issues|unfinished issues|issues that are not done|not done issues/.test(normalized);
  const mentionsLabels = /label|labels|labeling/.test(normalized);
  const labelMutationIntent =
    /add labels?|apply labels?|create labels?|label(?:ing)? pass|classif|categori[sz]e.*labels?/.test(
      normalized
    );
  const executionIntent =
    /process|implement|start processing|start working|work through|complete|execute|queue up|proceed with implementing|proceed with implementation/.test(
      normalized
    );
  return mentionsIssues && mentionsLabels && labelMutationIntent && !executionIntent;
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

export function looksLikePlanThenExecuteDirective(command: string, rest: string[]): boolean {
  const normalized = [command, ...rest].join(" ").trim().toLowerCase();
  const mentionsIssues = /github issue|github issues|open issues|unfinished issues|issues that are not done|not done issues/.test(normalized);
  const planningIntent = /plan|prioriti[sz]e|order|sequence|decide which should go first|figure out the best order|review/.test(normalized);
  const executionIntent =
    /process|implement|start processing|start working|work through|complete|execute|queue up|proceed with implementing|proceed with implementation/.test(
      normalized
    );
  return mentionsIssues && planningIntent && executionIntent;
}

export function classifyTopLevelInput(command: string, rest: string[]): "command" | "issue_labels" | "issue" | "repo" {
  if (RESERVED_COMMANDS.has(command)) {
    return "command";
  }

  if (looksLikeIssueDrivenDirective(command, rest)) {
    return "issue";
  }

  if (looksLikeIssueLabelingDirective(command, rest)) {
    return "issue_labels";
  }

  return "repo";
}

export function parseIssueDirectiveScope(command: string, rest: string[]): IssueDirectiveScope {
  const normalized = [command, ...rest].join(" ").trim().toLowerCase();
  const issueNumbers = [...normalized.matchAll(/#(\d+)/g)]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter((value) => Number.isInteger(value));

  const labelFilters = new Set<string>();
  for (const match of normalized.matchAll(/(?:with|having|has|for|prioritize)\s+(?:the\s+)?label\s+([a-z0-9][a-z0-9-]*)/g)) {
    if (match[1]) {
      labelFilters.add(match[1]);
    }
  }
  for (const match of normalized.matchAll(/([a-z0-9][a-z0-9-]*)\s+label/g)) {
    if (match[1]) {
      labelFilters.add(match[1]);
    }
  }

  const implementFirstOnly =
    /(implement|process|work through|complete).*(first one|first issue|the first one|the first issue)/.test(normalized) ||
    /then implement (the )?first/.test(normalized);

  return {
    issueNumbers,
    labelFilters: [...labelFilters],
    implementFirstOnly
  };
}
