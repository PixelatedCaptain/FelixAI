import { runCommand } from "./process-utils.js";

function buildEnvWithoutGitHubToken(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  return env;
}

function hasRetryableGitHubTokenError(message: string): boolean {
  return /HTTP 401: Bad credentials/i.test(message) || /failed to log in to github\.com using token/i.test(message);
}

function normalizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl.trim().replace(/\.git$/, "");
}

export function buildCompareUrl(remoteUrl: string, baseBranch: string, headBranch: string): string | undefined {
  const normalized = normalizeRemoteUrl(remoteUrl);
  if (!/github\.com[:/]/i.test(normalized)) {
    return undefined;
  }

  if (normalized.startsWith("git@github.com:")) {
    const repo = normalized.slice("git@github.com:".length);
    return `https://github.com/${repo}/compare/${baseBranch}...${encodeURIComponent(headBranch)}?expand=1`;
  }

  if (normalized.startsWith("https://github.com/")) {
    return `${normalized}/compare/${baseBranch}...${encodeURIComponent(headBranch)}?expand=1`;
  }

  return undefined;
}

export async function createPullRequest(options: {
  repoPath: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<{ number?: number; url?: string; status: "draft" | "open" }> {
  return createPullRequestWithRunner(options, runCommand);
}

export async function runGitHubCli(
  repoPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return runGitHubCliWithRunner(repoPath, args, runCommand);
}

export async function runGitHubCliWithRunner(
  repoPath: string,
  args: string[],
  runner: typeof runCommand
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runner("gh", args, { cwd: repoPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ghAuthStatus = await getGitHubCliStatusWithRunner(repoPath, runner);
    if (hasGitHubTokenPrecedenceConflict(ghAuthStatus) || (!!process.env.GITHUB_TOKEN && hasRetryableGitHubTokenError(message))) {
      return await runner("gh", args, {
        cwd: repoPath,
        env: buildEnvWithoutGitHubToken()
      });
    }

    throw new Error(message);
  }
}

export async function createPullRequestWithRunner(
  options: {
    repoPath: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  },
  runner: typeof runCommand
): Promise<{ number?: number; url?: string; status: "draft" | "open" }> {
  const args = [
    "pr",
    "create",
    "--base",
    options.baseBranch,
    "--head",
    options.headBranch,
    "--title",
    options.title,
    "--body",
    options.body
  ];
  if (options.draft) {
    args.push("--draft");
  }

  try {
    const result = await runGitHubCliWithRunner(options.repoPath, args, runner);
    const url = result.stdout.split(/\r?\n/).find((line) => /^https:\/\/github\.com\//i.test(line.trim()))?.trim();
    const numberMatch = url?.match(/\/pull\/(\d+)$/);
    return {
      number: numberMatch ? Number.parseInt(numberMatch[1], 10) : undefined,
      url,
      status: options.draft ? "draft" : "open"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ghAuthStatus = await getGitHubCliStatusWithRunner(options.repoPath, runner);
    if (hasGitHubTokenPrecedenceConflict(ghAuthStatus)) {
      try {
        const result = await runGitHubCliWithRunner(options.repoPath, args, runner);
        const url = result.stdout.split(/\r?\n/).find((line) => /^https:\/\/github\.com\//i.test(line.trim()))?.trim();
        const numberMatch = url?.match(/\/pull\/(\d+)$/);
        return {
          number: numberMatch ? Number.parseInt(numberMatch[1], 10) : undefined,
          url,
          status: options.draft ? "draft" : "open"
        };
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        const existingUrl = extractPullRequestUrl(retryMessage);
        if (existingUrl) {
          const existingNumberMatch = existingUrl.match(/\/pull\/(\d+)$/);
          return {
            number: existingNumberMatch ? Number.parseInt(existingNumberMatch[1], 10) : undefined,
            url: existingUrl,
            status: "open"
          };
        }

        throw new Error(retryMessage);
      }
    }

    throw new Error(message);
  }
}

function extractPullRequestUrl(message: string): string | undefined {
  const match = message.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/i);
  return match?.[0];
}

export async function getGitHubCliStatus(repoPath: string): Promise<string | undefined> {
  return getGitHubCliStatusWithRunner(repoPath, runCommand);
}

export async function listGitHubLabels(repoPath: string): Promise<string[]> {
  const result = await runGitHubCli(repoPath, ["label", "list", "--limit", "200", "--json", "name"]);
  const parsed = JSON.parse(result.stdout) as Array<{ name?: string }>;
  return parsed.map((entry) => entry.name?.trim()).filter((value): value is string => Boolean(value));
}

export async function ensureGitHubLabel(options: {
  repoPath: string;
  name: string;
  color: string;
  description: string;
}): Promise<void> {
  const existing = await listGitHubLabels(options.repoPath);
  if (existing.includes(options.name)) {
    return;
  }

  await runGitHubCli(options.repoPath, [
    "label",
    "create",
    options.name,
    "--color",
    options.color,
    "--description",
    options.description
  ]);
}

export async function addLabelsToGitHubIssue(options: {
  repoPath: string;
  issueNumber: number;
  labels: string[];
}): Promise<void> {
  if (options.labels.length === 0) {
    return;
  }

  const args = ["issue", "edit", String(options.issueNumber)];
  for (const label of options.labels) {
    args.push("--add-label", label);
  }

  await runGitHubCli(options.repoPath, args);
}

export async function getGitHubCliStatusWithRunner(repoPath: string, runner: typeof runCommand): Promise<string | undefined> {
  try {
    const result = await runner("gh", ["auth", "status"], { cwd: repoPath });
    return [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n").trim() || undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function hasGitHubTokenPrecedenceConflict(statusText?: string): boolean {
  if (!statusText) {
    return false;
  }

  const invalidEnvToken =
    /failed to log in to github\.com using token \(github_token\)/i.test(statusText) ||
    /token in github_token is invalid/i.test(statusText);
  const keyringLoginExists =
    /logged in to github\.com account .* \(keyring\)/i.test(statusText) &&
    /active account:\s*false/i.test(statusText);

  return invalidEnvToken && keyringLoginExists;
}

export function buildPullRequestFailureMessage(error: string, ghAuthStatus?: string): string {
  const normalizedError = error.trim();
  const normalizedAuth = ghAuthStatus?.trim();
  if (!normalizedAuth) {
    return normalizedError;
  }

  if (hasGitHubTokenPrecedenceConflict(normalizedAuth)) {
    return `${normalizedError}\nGitHub CLI has a valid keyring login, but an invalid GITHUB_TOKEN is taking precedence. Clear or fix GITHUB_TOKEN and retry.`;
  }

  return `${normalizedError}\nGitHub CLI status:\n${normalizedAuth}`;
}
