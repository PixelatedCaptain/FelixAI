export function looksLikeIssueDrivenDirective(command: string, rest: string[]): boolean {
  const normalized = [command, ...rest].join(" ").trim().toLowerCase();
  return /github issue|github issues|open issues|unfinished issues|issues that are not done|issue order|process.*issues|review.*issues/.test(
    normalized
  );
}
