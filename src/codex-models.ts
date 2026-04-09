import path from "node:path";
import { readFile } from "node:fs/promises";

import { pathExists, readJsonFile } from "./fs-utils.js";

export interface CodexModelCatalogEntry {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoningLevel?: string;
  priority?: number;
  visibility?: string;
}

interface CodexModelsCacheFile {
  models?: Array<{
    slug?: string;
    display_name?: string;
    description?: string;
    default_reasoning_level?: string;
    priority?: number;
    visibility?: string;
  }>;
}

function getCodexHome(): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "~", ".codex");
}

function getModelsCachePath(): string {
  return path.join(getCodexHome(), "models_cache.json");
}

function getCodexConfigPath(): string {
  return path.join(getCodexHome(), "config.toml");
}

export function normalizeCodexModelSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function isUnsupportedCodexModelError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /model.+not supported/i.test(message) || /invalid_request_error/i.test(message);
}

export async function loadCodexModelCatalog(): Promise<CodexModelCatalogEntry[]> {
  const modelsCachePath = getModelsCachePath();
  if (!(await pathExists(modelsCachePath))) {
    return [];
  }

  const raw = await readJsonFile<CodexModelsCacheFile>(modelsCachePath);
  const entries = raw.models ?? [];
  const seen = new Set<string>();

  const normalized: CodexModelCatalogEntry[] = [];
  for (const entry of entries) {
      const slug = normalizeCodexModelSlug(entry.slug ?? "");
      if (!slug) {
        continue;
      }

      normalized.push({
        slug,
        displayName: entry.display_name?.trim() || slug,
        description: entry.description?.trim() || undefined,
        defaultReasoningLevel: entry.default_reasoning_level?.trim() || undefined,
        priority: entry.priority,
        visibility: entry.visibility?.trim() || undefined
      });
  }

  return normalized
    .filter((entry) => {
      if (seen.has(entry.slug)) {
        return false;
      }
      seen.add(entry.slug);
      return true;
    })
    .sort((left, right) => {
      const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.slug.localeCompare(right.slug);
    });
}

export async function loadCurrentCodexModel(): Promise<string | undefined> {
  const configPath = getCodexConfigPath();
  if (!(await pathExists(configPath))) {
    return undefined;
  }

  let text = "";
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }
  const match = text.match(/^model\s*=\s*"([^"]+)"/im);
  return match?.[1] ? normalizeCodexModelSlug(match[1]) : undefined;
}

export function findCodexModelEntry(
  catalog: CodexModelCatalogEntry[],
  model: string | undefined
): CodexModelCatalogEntry | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = normalizeCodexModelSlug(model);
  return catalog.find((entry) => entry.slug === normalized);
}
