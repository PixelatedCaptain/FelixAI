import path from "node:path";

import { ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { STATE_SCHEMA_VERSION, type FelixConfig } from "./types.js";
import { migrateConfig, validateConfig } from "./validation.js";

export const DEFAULT_CONFIG: FelixConfig = {
  schemaVersion: STATE_SCHEMA_VERSION,
  stateDir: ".felixai/state",
  workspaceRoot: ".felixai/workspaces",
  logDir: ".felixai/logs",
  credentialSource: "chatgpt-session",
  codex: {
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    modelReasoningEffort: "high",
    webSearchMode: "cached",
    networkAccessEnabled: false,
    parallelism: 2,
    autoResume: false,
    maxResumesPerItem: 2
  }
};

export function getConfigPath(projectRoot = process.cwd()): string {
  return path.join(path.resolve(projectRoot), ".felixai", "config.json");
}

export async function ensureFelixDirectories(projectRoot = process.cwd()): Promise<void> {
  const root = path.resolve(projectRoot);
  await ensureDirectory(path.join(root, ".felixai"));
  await ensureDirectory(path.join(root, ".felixai", "state"));
  await ensureDirectory(path.join(root, ".felixai", "state", "jobs"));
  await ensureDirectory(path.join(root, ".felixai", "workspaces"));
  await ensureDirectory(path.join(root, ".felixai", "logs"));
}

export async function loadConfig(projectRoot = process.cwd()): Promise<FelixConfig> {
  const configPath = getConfigPath(projectRoot);
  if (!(await pathExists(configPath))) {
    return validateConfig(structuredClone(DEFAULT_CONFIG));
  }

  const raw = await readJsonFile<unknown>(configPath);
  return validateConfig(migrateConfig(raw));
}

export async function writeDefaultConfig(projectRoot = process.cwd(), force = false): Promise<boolean> {
  const configPath = getConfigPath(projectRoot);
  if (!force && (await pathExists(configPath))) {
    return false;
  }

  await ensureFelixDirectories(projectRoot);
  await writeJsonFile(configPath, validateConfig(structuredClone(DEFAULT_CONFIG)));
  return true;
}
