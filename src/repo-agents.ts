import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import type { ModelReasoningEffort } from "@openai/codex-sdk";

export interface RepoAgentsPreferences {
  path: string;
  content: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  turboMode?: boolean;
  encourageSubagents?: boolean;
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
