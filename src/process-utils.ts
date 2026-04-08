import { execFile, spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

export function runCommandInteractive(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      shell: process.platform === "win32"
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
  });
}
