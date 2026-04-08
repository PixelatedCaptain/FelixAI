import path from "node:path";

import { pathExists, readJsonFile } from "./fs-utils.js";
import { runCommand, runCommandInteractive } from "./process-utils.js";

interface CodexAuthFile {
  user_id?: string;
  email?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  userId?: string;
  authFilePath: string;
  rawStatus?: string;
}

function getAuthFilePath(): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "~", ".codex", "auth.json");
}

export async function loginWithCodex(): Promise<void> {
  await runCommandInteractive("codex", ["login"]);
}

export async function logoutFromCodex(): Promise<void> {
  await runCommandInteractive("codex", ["logout"]);
}

export async function getCodexAuthStatus(): Promise<AuthStatus> {
  const authFilePath = getAuthFilePath();
  let rawStatus = "";
  try {
    const result = await runCommand("codex", ["login", "status"]);
    rawStatus = result.stdout || result.stderr;
  } catch (error) {
    rawStatus = error instanceof Error ? error.message : String(error);
  }

  if (!(await pathExists(authFilePath))) {
    return {
      loggedIn: false,
      authFilePath,
      rawStatus
    };
  }

  try {
    const auth = await readJsonFile<CodexAuthFile>(authFilePath);
    return {
      loggedIn: true,
      email: auth.email,
      userId: auth.user_id,
      authFilePath,
      rawStatus
    };
  } catch {
    return {
      loggedIn: true,
      authFilePath,
      rawStatus
    };
  }
}
