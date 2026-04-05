import path from "node:path";

import { ensureFelixDirectories, writeDefaultConfig } from "./config.js";
import { pathExists, writeJsonFile } from "./fs-utils.js";

interface InitOptions {
  projectRoot?: string;
  force?: boolean;
}

interface InitResult {
  created: string[];
  skipped: string[];
}

const DEFAULT_TASK = {
  task: "Use FelixAI Orchestrator to decompose and execute the next milestone for this repository."
};

async function writeIfAllowed(target: string, value: unknown, force: boolean): Promise<boolean> {
  if (!force && (await pathExists(target))) {
    return false;
  }

  await writeJsonFile(target, value);
  return true;
}

export async function initializeProject(options: InitOptions = {}): Promise<InitResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const force = options.force ?? false;

  const taskFile = path.join(projectRoot, "felixai.task.json");
  const configDir = path.join(projectRoot, ".felixai");
  const configFile = path.join(configDir, "config.json");
  const stateDir = path.join(configDir, "state");
  const jobsDir = path.join(stateDir, "jobs");
  const logDir = path.join(configDir, "logs");
  const workspaceDir = path.join(configDir, "workspaces");

  await ensureFelixDirectories(projectRoot);

  const created: string[] = [];
  const skipped: string[] = [];

  if (await writeIfAllowed(taskFile, DEFAULT_TASK, force)) {
    created.push(taskFile);
  } else {
    skipped.push(taskFile);
  }

  if (await writeDefaultConfig(projectRoot, force)) {
    created.push(configFile);
  } else {
    skipped.push(configFile);
  }

  created.push(stateDir, jobsDir, logDir, workspaceDir);

  return { created, skipped };
}
