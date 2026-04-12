import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "./fs-utils.js";

import type { ModelReasoningEffort } from "@openai/codex-sdk";

export interface RepoAgentsPreferences {
  path: string;
  content: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  turboMode?: boolean;
  encourageSubagents?: boolean;
}

export interface SharedRepoContext {
  sourceAgentsPath: string;
  sourceHash: string;
  contextPath: string;
  summary: string;
}

const REASONING_EFFORTS = new Set<ModelReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const TRUE_VALUES = new Set(["true", "yes", "on", "enabled", "enable", "1", "encouraged"]);
const FALSE_VALUES = new Set(["false", "no", "off", "disabled", "disable", "0"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchDirective(content: string, key: string | string[]): string | undefined {
  const keys = Array.isArray(key) ? key : [key];
  for (const directive of keys) {
    const match = content.match(new RegExp(`^${escapeRegex(directive)}:\\s*(.+)$`, "im"));
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return undefined;
}

function normalizeReasoningEffort(value: string | undefined): ModelReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }

  return REASONING_EFFORTS.has(value as ModelReasoningEffort) ? (value as ModelReasoningEffort) : undefined;
}

function normalizeBooleanDirective(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  return undefined;
}

function upsertDirective(content: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:\\s*.*$`, "im");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return `${line}\n`;
  }

  return `${line}\n${trimmed}\n`;
}

export function parseRepoAgentsPreferences(content: string, agentsPath = "AGENTS.md"): RepoAgentsPreferences | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }

  return {
    path: agentsPath,
    content: trimmed,
    model: matchDirective(trimmed, "model"),
    reasoningEffort: normalizeReasoningEffort(matchDirective(trimmed, "reasoning_effort")),
    turboMode: normalizeBooleanDirective(matchDirective(trimmed, ["turbo_mode", "turbo"])),
    encourageSubagents: normalizeBooleanDirective(matchDirective(trimmed, ["encourage_subagents", "subagents"]))
  };
}

export async function loadRepoAgentsPreferences(repoRoot: string): Promise<RepoAgentsPreferences | undefined> {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  try {
    const content = await readFile(agentsPath, "utf8");
    return parseRepoAgentsPreferences(content, agentsPath);
  } catch {
    return undefined;
  }
}

export async function saveRepoAgentsPreferences(
  repoRoot: string,
  preferences: {
    model?: string;
    reasoningEffort?: ModelReasoningEffort;
    turboMode?: boolean;
    encourageSubagents?: boolean;
  }
): Promise<RepoAgentsPreferences> {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  let content = "";
  try {
    content = await readFile(agentsPath, "utf8");
  } catch {
    content = "";
  }

  let next = content;
  if (preferences.model) {
    next = upsertDirective(next, "model", preferences.model);
  }
  if (preferences.reasoningEffort) {
    next = upsertDirective(next, "reasoning_effort", preferences.reasoningEffort);
  }
  if (preferences.turboMode !== undefined) {
    next = upsertDirective(next, "turbo_mode", preferences.turboMode ? "true" : "false");
  }
  if (preferences.encourageSubagents !== undefined) {
    next = upsertDirective(next, "encourage_subagents", preferences.encourageSubagents ? "true" : "false");
  }

  const normalized = next.trimEnd();
  await writeFile(agentsPath, `${normalized}\n`, "utf8");
  return parseRepoAgentsPreferences(normalized, agentsPath) as RepoAgentsPreferences;
}

export function buildExecutionPolicyInstructions(preferences: {
  turboMode?: boolean;
  encourageSubagents?: boolean;
}): string[] {
  const lines: string[] = [];

  if (preferences.turboMode) {
    lines.push("Execution policy: turbo mode is enabled for this repository. Prefer faster decisive progress and deeper safe parallelism.");
  }

  if (preferences.encourageSubagents) {
    lines.push("Execution policy: use subagents aggressively when the environment supports them and the work can be split safely.");
  }

  return lines;
}

function hashContent(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function extractLinkedDocs(content: string): string[] {
  const links = new Set<string>();
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of content.matchAll(regex)) {
    const target = match[1]?.trim();
    if (target) {
      links.add(target);
    }
  }
  return [...links].slice(0, 12);
}

function buildSharedRepoContextMarkdown(repoRoot: string, preferences: RepoAgentsPreferences): { summary: string; content: string } {
  const linkedDocs = extractLinkedDocs(preferences.content);
  const excerptLines = preferences.content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 60);

  const summaryParts = [
    `Source AGENTS: ${preferences.path}`,
    preferences.model ? `Model: ${preferences.model}` : undefined,
    preferences.reasoningEffort ? `Reasoning: ${preferences.reasoningEffort}` : undefined,
    preferences.turboMode !== undefined ? `Turbo: ${preferences.turboMode ? "enabled" : "disabled"}` : undefined,
    preferences.encourageSubagents !== undefined ? `Subagents: ${preferences.encourageSubagents ? "enabled" : "disabled"}` : undefined
  ].filter((value): value is string => Boolean(value));

  const content = [
    "# Felix Shared Repo Context",
    "",
    `Repository root: ${repoRoot}`,
    ...summaryParts,
    "",
    "Use this file as the first source for project-level operating instructions.",
    "Consult AGENTS.md only if this cache is missing a detail you need.",
    "",
    linkedDocs.length > 0 ? "## Linked Docs" : undefined,
    ...(linkedDocs.length > 0 ? linkedDocs.map((doc) => `- ${doc}`) : []),
    linkedDocs.length > 0 ? "" : undefined,
    "## AGENTS Excerpt",
    ...excerptLines
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");

  return {
    summary: summaryParts.join(" | "),
    content
  };
}

export async function ensureSharedRepoContext(projectRoot: string, repoRoot: string): Promise<SharedRepoContext | undefined> {
  const preferences = await loadRepoAgentsPreferences(repoRoot);
  if (!preferences) {
    return undefined;
  }

  const sourceHash = hashContent(preferences.content);
  const stateDir = path.join(projectRoot, ".felixai", "state", "repo-context");
  const contextPath = path.join(stateDir, "shared-repo-context.md");
  const metadataPath = path.join(stateDir, "shared-repo-context.json");

  await ensureDirectory(stateDir);

  const prior = (await pathExists(metadataPath).then((exists) => (exists ? readJsonFile<{ sourceHash?: string; summary?: string }>(metadataPath) : undefined)).catch(
    () => undefined
  )) as { sourceHash?: string; summary?: string } | undefined;

  if (prior?.sourceHash === sourceHash && (await pathExists(contextPath))) {
    return {
      sourceAgentsPath: preferences.path,
      sourceHash,
      contextPath,
      summary: prior.summary ?? `Source AGENTS: ${preferences.path}`
    };
  }

  const built = buildSharedRepoContextMarkdown(repoRoot, preferences);
  await writeFile(contextPath, `${built.content.trimEnd()}\n`, "utf8");
  await writeJsonFile(metadataPath, {
    sourceAgentsPath: preferences.path,
    sourceHash,
    summary: built.summary,
    updatedAt: new Date().toISOString()
  });

  return {
    sourceAgentsPath: preferences.path,
    sourceHash,
    contextPath,
    summary: built.summary
  };
}
