import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import type { ModelReasoningEffort } from "@openai/codex-sdk";

export interface RepoAgentsPreferences {
  path: string;
  content: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
}

const REASONING_EFFORTS = new Set<ModelReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

function matchDirective(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || undefined;
}

function normalizeReasoningEffort(value: string | undefined): ModelReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }

  return REASONING_EFFORTS.has(value as ModelReasoningEffort) ? (value as ModelReasoningEffort) : undefined;
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

export async function loadRepoAgentsPreferences(repoRoot: string): Promise<RepoAgentsPreferences | undefined> {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  try {
    const content = await readFile(agentsPath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) {
      return undefined;
    }

    return {
      path: agentsPath,
      content: trimmed,
      model: matchDirective(trimmed, "model"),
      reasoningEffort: normalizeReasoningEffort(matchDirective(trimmed, "reasoning_effort"))
    };
  } catch {
    return undefined;
  }
}

export async function saveRepoAgentsPreferences(
  repoRoot: string,
  preferences: {
    model?: string;
    reasoningEffort?: ModelReasoningEffort;
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

  const normalized = next.trimEnd();
  await writeFile(agentsPath, `${normalized}\n`, "utf8");
  return {
    path: agentsPath,
    content: normalized,
    model: matchDirective(normalized, "model"),
    reasoningEffort: normalizeReasoningEffort(matchDirective(normalized, "reasoning_effort"))
  };
}
