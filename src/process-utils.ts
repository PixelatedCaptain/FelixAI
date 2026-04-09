import { execFile, spawn } from "node:child_process";
import path from "node:path";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

function isWindowsBatchCommand(commandPath: string): boolean {
  const extension = path.extname(commandPath).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function looksLikePath(command: string): boolean {
  return /[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(path.basename(command));
}

function parseWhereOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function quoteForCmd(argument: string): string {
  if (argument.length === 0) {
    return '""';
  }

  const escaped = argument
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")
    .replace(/[%^&|<>()!]/g, "^$&");

  return /[\s"%^&|<>()!]/.test(argument) ? `"${escaped}"` : escaped;
}

function buildCmdInvocation(command: string, args: string[]): string {
  return [quoteForCmd(command), ...args.map(quoteForCmd)].join(" ");
}

async function resolveWindowsCommand(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  if (looksLikePath(command)) {
    return command;
  }

  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile("where.exe", [command], { env, encoding: "utf8" }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    const candidates = parseWhereOutput(result);
    if (candidates.length === 0) {
      return command;
    }

    const preferred =
      candidates.find((candidate) => /\.exe$/i.test(candidate)) ??
      candidates.find((candidate) => /\.com$/i.test(candidate)) ??
      candidates.find((candidate) => /\.cmd$/i.test(candidate)) ??
      candidates.find((candidate) => /\.bat$/i.test(candidate)) ??
      candidates[0];

    return preferred;
  } catch {
    return command;
  }
}

async function resolveSpawnTarget(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<SpawnTarget> {
  if (process.platform !== "win32") {
    return { command, args };
  }

  const resolvedCommand = await resolveWindowsCommand(command, env);
  if (isWindowsBatchCommand(resolvedCommand)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdInvocation(resolvedCommand, args)]
    };
  }

  return {
    command: resolvedCommand,
    args
  };
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const target = await resolveSpawnTarget(command, args, options.env);
      execFile(target.command, target.args, { cwd: options.cwd, env: options.env, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });
    })().catch(reject);
  });
}

export function runCommandInteractive(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const target = await resolveSpawnTarget(command, args, options.env);
      const child = spawn(target.command, target.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: "inherit",
        shell: false
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`Command '${command}' exited with code ${code ?? "unknown"}.`));
      });
    })().catch(reject);
  });
}
