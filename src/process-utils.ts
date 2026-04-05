import { execFile } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, encoding: "utf8" }, (error, stdout, stderr) => {
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
