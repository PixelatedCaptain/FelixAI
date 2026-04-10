import os from "node:os";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

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

export function formatTranscriptLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as {
      timestamp?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };
    const timestamp = parsed.timestamp ?? "unknown-time";
    const type = parsed.type ?? "unknown";
    const payload = parsed.payload ?? {};

    if (type === "session_meta") {
      const id = typeof payload.id === "string" ? payload.id : "unknown";
      const cwd = typeof payload.cwd === "string" ? payload.cwd : "unknown";
      const model = typeof payload["model_slug"] === "string" ? payload["model_slug"] : undefined;
      const summary = model ? `session ${id} cwd=${cwd} model=${model}` : `session ${id} cwd=${cwd}`;
      return `[${timestamp}] meta ${clip(summary)}`;
    }

    if (type === "event_msg") {
      const eventType = typeof payload.type === "string" ? payload.type : "event";
      return `[${timestamp}] event ${clip(eventType)}`;
    }

    if (type === "response_item") {
      const itemType = typeof payload.type === "string" ? payload.type : "item";
      if (itemType === "message") {
        const role = typeof payload.role === "string" ? payload.role : "message";
        const text = extractMessageText(payload) ?? "";
        return `[${timestamp}] ${role}: ${clip(text || "[no text]")}`;
      }
      if (itemType === "reasoning") {
        return `[${timestamp}] reasoning`;
      }
      if (itemType === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        return `[${timestamp}] tool call ${name}`;
      }
      if (itemType === "function_call_output") {
        const output = typeof payload.output === "string" ? payload.output : "";
        const firstLine = output.split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? "[no output]";
        return `[${timestamp}] tool output ${clip(firstLine)}`;
      }
      return `[${timestamp}] item ${clip(itemType)}`;
    }

    return `[${timestamp}] ${clip(type)}`;
  } catch {
    return line;
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
  }
): Promise<void> {
  const lineCount = options?.lineCount ?? 40;
  const raw = options?.raw ?? false;
  const follow = options?.follow ?? true;
  const onLine = options?.onLine ?? ((line: string) => console.log(line));

  const initialLines = await readTranscriptTail(filePath, lineCount);
  for (const line of initialLines) {
    onLine(raw ? line : formatTranscriptLine(line));
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
      onLine(raw ? line : formatTranscriptLine(line));
    }
  }
}
