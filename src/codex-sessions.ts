import os from "node:os";
import path from "node:path";
import { appendFile, readdir, readFile, stat, writeFile } from "node:fs/promises";

import { ensureDirectory } from "./fs-utils.js";

function getCodexHome(): string {
  return path.join(process.env.USERPROFILE ?? os.homedir(), ".codex");
}

export function getCodexSessionsRoot(): string {
  return path.join(getCodexHome(), "sessions");
}

async function walkFiles(root: string, results: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, results);
      continue;
    }
    results.push(fullPath);
  }
  return results;
}

export async function findCodexSessionTranscript(sessionId: string): Promise<string | undefined> {
  const sessionsRoot = getCodexSessionsRoot();
  const files = await walkFiles(sessionsRoot).catch(() => []);
  const match = files
    .filter((filePath) => filePath.endsWith(".jsonl") && filePath.includes(sessionId))
    .sort()
    .at(-1);
  return match;
}

export async function readTranscriptLines(filePath: string): Promise<string[]> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export async function readTranscriptTail(filePath: string, lineCount = 40): Promise<string[]> {
  const lines = await readTranscriptLines(filePath);
  return lines.slice(-lineCount);
}

function clip(value: string, max = 180): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

function parseTranscriptJson(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error("Empty transcript line.");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const firstBraceIndex = trimmed.indexOf("{");
  if (firstBraceIndex >= 0) {
    return JSON.parse(trimmed.slice(firstBraceIndex));
  }

  throw new Error("Transcript line is not JSON.");
}

function extractMessageText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const payloadObject = payload as { content?: Array<{ text?: string }> };
  const text = payloadObject.content
    ?.map((item) => item?.text)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  return text?.trim();
}

function readTimestamp(value: Record<string, unknown>): string {
  return typeof value.timestamp === "string" ? value.timestamp : "unknown-time";
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function summarizeToolOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "[no output]";
  }

  const exitLine = lines.find((line) => /^Exit code:\s+/i.test(line));
  const exitCode = exitLine?.match(/^Exit code:\s+(.+)$/i)?.[1]?.trim();
  const contentLines = lines.filter((line) => !/^Exit code:\s+/i.test(line) && !/^Wall time:\s+/i.test(line) && line !== "Output:");
  const firstContent = contentLines[0];

  if (exitCode && firstContent) {
    if (contentLines.length > 1) {
      return `exit=${exitCode} ${clip(firstContent)} (+${contentLines.length - 1} more lines)`;
    }
    return `exit=${exitCode} ${clip(firstContent)}`;
  }

  if (exitCode) {
    return `exit=${exitCode}`;
  }

  if (contentLines.length > 1) {
    return `${clip(contentLines[0]!)} (+${contentLines.length - 1} more lines)`;
  }

  return clip(contentLines[0]!);
}

function formatDirectResponseItem(item: Record<string, unknown>, timestamp: string): string | undefined {
  const itemType = readString(item, "type") ?? "item";

  if (itemType === "message") {
    const role = readString(item, "role") ?? "message";
    const text = extractMessageText(item) ?? "[no text]";
    return `[${timestamp}] ${role}: ${clip(text)}`;
  }

  if (itemType === "reasoning") {
    return `[${timestamp}] reasoning`;
  }

  if (itemType === "function_call") {
    const name = readString(item, "name") ?? "tool";
    return `[${timestamp}] tool call ${name}`;
  }

  if (itemType === "function_call_output") {
    const output = readString(item, "output") ?? "";
    return `[${timestamp}] tool output ${summarizeToolOutput(output)}`;
  }

  if (itemType === "event_msg") {
    const eventType = readString(item, "type") ?? "event";
    return `[${timestamp}] event ${clip(eventType)}`;
  }

  return `[${timestamp}] item ${clip(itemType)}`;
}

export function formatTranscriptLine(line: string): string {
  try {
    const parsed = parseTranscriptJson(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return clip(line);
    }

    const parsedObject = parsed as Record<string, unknown>;
    const timestamp = readTimestamp(parsedObject);
    const type = readString(parsedObject, "type") ?? "unknown";
    const payload = (parsedObject.payload && typeof parsedObject.payload === "object" && !Array.isArray(parsedObject.payload)
      ? (parsedObject.payload as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    if (type === "session_meta") {
      const id = readString(payload, "id") ?? "unknown";
      const cwd = readString(payload, "cwd") ?? "unknown";
      const model = readString(payload, "model_slug");
      const summary = model ? `session ${id} cwd=${cwd} model=${model}` : `session ${id} cwd=${cwd}`;
      return `[${timestamp}] meta ${clip(summary)}`;
    }

    if (type === "event_msg") {
      const eventType = readString(payload, "type") ?? "event";
      return `[${timestamp}] event ${clip(eventType)}`;
    }

    if (type === "response_item") {
      return formatDirectResponseItem(payload, timestamp) ?? `[${timestamp}] item`;
    }

    if (type === "turn_context") {
      return `[${timestamp}] turn_context`;
    }

    if (type === "user") {
      const text = readString(parsedObject, "text") ?? readString(parsedObject, "message") ?? "[user input]";
      return `[${timestamp}] user: ${clip(text)}`;
    }

    if (type === "assistant") {
      const text = readString(parsedObject, "text") ?? readString(parsedObject, "message") ?? "[assistant output]";
      return `[${timestamp}] assistant: ${clip(text)}`;
    }

    if (["message", "reasoning", "function_call", "function_call_output"].includes(type)) {
      return formatDirectResponseItem(parsedObject, timestamp) ?? `[${timestamp}] item ${clip(type)}`;
    }

    if (type === "token_count") {
      return `[${timestamp}] event token_count`;
    }

    return `[${timestamp}] ${clip(type)}`;
  } catch {
    return clip(line);
  }
}

export async function watchTranscript(
  filePath: string,
  options?: {
    lineCount?: number;
    raw?: boolean;
    follow?: boolean;
    onLine?: (line: string) => void;
    pollIntervalMs?: number;
    teeFilePath?: string;
  }
): Promise<void> {
  const lineCount = options?.lineCount ?? 40;
  const raw = options?.raw ?? false;
  const follow = options?.follow ?? true;
  const onLine = options?.onLine ?? ((line: string) => console.log(line));
  const teeFilePath = options?.teeFilePath;

  if (teeFilePath) {
    await ensureDirectory(path.dirname(teeFilePath));
    await writeFile(teeFilePath, "", "utf8");
  }

  const emitLine = async (line: string): Promise<void> => {
    onLine(line);
    if (teeFilePath) {
      await appendFile(teeFilePath, `${line}\n`, "utf8");
    }
  };

  const initialLines = await readTranscriptTail(filePath, lineCount);
  for (const line of initialLines) {
    await emitLine(raw ? line : formatTranscriptLine(line));
  }

  if (!follow) {
    return;
  }

  let position = (await stat(filePath)).size;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, options?.pollIntervalMs ?? 1000));
    const nextStat = await stat(filePath).catch(() => undefined);
    if (!nextStat || nextStat.size <= position) {
      continue;
    }

    const contents = await readFile(filePath, "utf8");
    const nextChunk = contents.slice(position);
    position = nextStat.size;
    const lines = nextChunk
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      await emitLine(raw ? line : formatTranscriptLine(line));
    }
  }
}
