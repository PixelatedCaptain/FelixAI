import crypto from "node:crypto";
import path from "node:path";

import { ensureDirectory, readJsonFile, writeJsonFile } from "./fs-utils.js";

function hashRepoRoot(repoRoot: string): string {
  return crypto.createHash("sha1").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);
}

function issueStateRoot(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".felixai", "state", "issues");
}

export function getIssueSnapshotPath(projectRoot: string, repoRoot: string): string {
  return path.join(issueStateRoot(projectRoot), `${hashRepoRoot(repoRoot)}.snapshot.json`);
}

export function getIssuePlanPath(projectRoot: string, repoRoot: string): string {
  return path.join(issueStateRoot(projectRoot), `${hashRepoRoot(repoRoot)}.plan.json`);
}

export function getIssueRunPath(projectRoot: string, repoRoot: string): string {
  return path.join(issueStateRoot(projectRoot), `${hashRepoRoot(repoRoot)}.run.json`);
}

export function getIssueConversationPath(projectRoot: string, repoRoot: string): string {
  return path.join(issueStateRoot(projectRoot), `${hashRepoRoot(repoRoot)}.conversation.json`);
}

export function getCurrentShellSessionPath(projectRoot: string, repoRoot: string): string {
  return path.join(issueStateRoot(projectRoot), `${hashRepoRoot(repoRoot)}.shell.json`);
}

export function getWatchLogPath(
  projectRoot: string,
  repoRoot: string,
  jobId: string,
  workItemId: string,
  sessionId: string
): string {
  return path.join(
    path.resolve(projectRoot),
    ".felixai",
    "state",
    "watch-logs",
    `${hashRepoRoot(repoRoot)}-${jobId}-${workItemId}-${sessionId}.log`
  );
}

export async function saveIssueSnapshot(projectRoot: string, repoRoot: string, value: unknown): Promise<string> {
  const outputPath = getIssueSnapshotPath(projectRoot, repoRoot);
  await ensureDirectory(path.dirname(outputPath));
  await writeJsonFile(outputPath, value);
  return outputPath;
}

export async function saveIssuePlan(projectRoot: string, repoRoot: string, value: unknown): Promise<string> {
  const outputPath = getIssuePlanPath(projectRoot, repoRoot);
  await ensureDirectory(path.dirname(outputPath));
  await writeJsonFile(outputPath, value);
  return outputPath;
}

export async function saveIssueRun(projectRoot: string, repoRoot: string, value: unknown): Promise<string> {
  const outputPath = getIssueRunPath(projectRoot, repoRoot);
  await ensureDirectory(path.dirname(outputPath));
  await writeJsonFile(outputPath, value);
  return outputPath;
}

export async function saveIssueConversation(projectRoot: string, repoRoot: string, value: unknown): Promise<string> {
  const outputPath = getIssueConversationPath(projectRoot, repoRoot);
  await ensureDirectory(path.dirname(outputPath));
  await writeJsonFile(outputPath, value);
  return outputPath;
}

export async function saveCurrentShellSession(projectRoot: string, repoRoot: string, value: unknown): Promise<string> {
  const outputPath = getCurrentShellSessionPath(projectRoot, repoRoot);
  await ensureDirectory(path.dirname(outputPath));
  await writeJsonFile(outputPath, value);
  return outputPath;
}

export async function loadIssueSnapshot<T>(projectRoot: string, repoRoot: string): Promise<T> {
  return readJsonFile<T>(getIssueSnapshotPath(projectRoot, repoRoot));
}

export async function loadIssuePlan<T>(projectRoot: string, repoRoot: string): Promise<T> {
  return readJsonFile<T>(getIssuePlanPath(projectRoot, repoRoot));
}

export async function loadIssueRun<T>(projectRoot: string, repoRoot: string): Promise<T> {
  return readJsonFile<T>(getIssueRunPath(projectRoot, repoRoot));
}

export async function loadIssueConversation<T>(projectRoot: string, repoRoot: string): Promise<T> {
  return readJsonFile<T>(getIssueConversationPath(projectRoot, repoRoot));
}

export async function loadCurrentShellSession<T>(projectRoot: string, repoRoot: string): Promise<T> {
  return readJsonFile<T>(getCurrentShellSessionPath(projectRoot, repoRoot));
}
