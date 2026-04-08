import { getCodexAuthStatus } from "./auth.js";
import { getGitHubCliStatus } from "./github.js";
import { runCommand } from "./process-utils.js";

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  summary: string;
  detail?: string;
}

export interface DoctorReport {
  overallStatus: "ok" | "warn" | "fail";
  checks: DoctorCheck[];
}

async function checkCommand(command: string, args: string[] = ["--version"]): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const result = await runCommand(command, args);
    return {
      ok: true,
      output: [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n").trim() || undefined
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function analyzeGitHubAuthStatus(statusText?: string): DoctorCheck {
  if (!statusText) {
    return {
      id: "github-auth",
      status: "warn",
      summary: "GitHub CLI auth status is unavailable."
    };
  }

  const invalidEnvToken =
    /failed to log in to github\.com using token \(github_token\)/i.test(statusText) ||
    /token in github_token is invalid/i.test(statusText);
  const keyringLoginExists =
    /logged in to github\.com account .* \(keyring\)/i.test(statusText) &&
    /token scopes:/i.test(statusText);

  if (invalidEnvToken && keyringLoginExists) {
    return {
      id: "github-auth",
      status: "warn",
      summary: "GitHub CLI auth is conflicted.",
      detail: "A valid keyring login exists, but an invalid GITHUB_TOKEN is taking precedence. Clear or fix GITHUB_TOKEN."
    };
  }

  if (/logged in to github\.com account/i.test(statusText)) {
    return {
      id: "github-auth",
      status: "ok",
      summary: "GitHub CLI has a usable login.",
      detail: statusText
    };
  }

  return {
    id: "github-auth",
    status: "warn",
    summary: "GitHub CLI is installed but not clearly authenticated.",
    detail: statusText
  };
}

export async function runDoctor(repoPath = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const node = await checkCommand("node");
  checks.push({
    id: "node",
    status: node.ok ? "ok" : "fail",
    summary: node.ok ? "Node.js is available." : "Node.js is not available.",
    detail: node.ok ? node.output : node.error
  });

  const git = await checkCommand("git");
  checks.push({
    id: "git",
    status: git.ok ? "ok" : "fail",
    summary: git.ok ? "Git is available." : "Git is not available.",
    detail: git.ok ? git.output : git.error
  });

  const codex = await checkCommand("codex");
  checks.push({
    id: "codex",
    status: codex.ok ? "ok" : "fail",
    summary: codex.ok ? "Codex CLI is available." : "Codex CLI is not available.",
    detail: codex.ok ? codex.output : codex.error
  });

  const codexAuth = await getCodexAuthStatus();
  checks.push({
    id: "codex-auth",
    status: codexAuth.loggedIn ? "ok" : "warn",
    summary: codexAuth.loggedIn ? "Codex login is active." : "Codex login is not active.",
    detail: codexAuth.rawStatus || codexAuth.authFilePath
  });

  const gh = await checkCommand("gh");
  checks.push({
    id: "gh",
    status: gh.ok ? "ok" : "warn",
    summary: gh.ok ? "GitHub CLI is available." : "GitHub CLI is not available.",
    detail: gh.ok ? gh.output : gh.error
  });

  if (gh.ok) {
    checks.push(analyzeGitHubAuthStatus(await getGitHubCliStatus(repoPath)));
  }

  const overallStatus = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "ok";

  return {
    overallStatus,
    checks
  };
}
