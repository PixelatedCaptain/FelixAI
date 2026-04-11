#!/usr/bin/env node

import path from "node:path";
import readline, { type Interface as ReadlineInterface } from "node:readline/promises";

import { readJsonFile } from "./fs-utils.js";
import packageJson from "../package.json" with { type: "json" };
import { getCodexAuthStatus, loginWithCodex, logoutFromCodex } from "./auth.js";
import { CodexAdapter } from "./codex-adapter.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  findCodexModelEntry,
  loadCodexModelCatalog,
  loadCurrentCodexModel,
  normalizeCodexModelSlug,
  type CodexModelCatalogEntry
} from "./codex-models.js";
import { findCodexSessionTranscript, watchTranscript } from "./codex-sessions.js";
import { runDoctor } from "./doctor.js";
import { assertGitRepository, getPreferredRemote, getRemoteUrl, resolveGitRoot } from "./git.js";
import { snapshotUnfinishedGitHubIssues } from "./github-issues.js";
import { addLabelsToGitHubIssue, ensureGitHubLabel } from "./github.js";
import { initializeProject } from "./init.js";
import { IntentParser, type PriorIssueAnalysisContext } from "./intent-parser.js";
import { IssueAnalyst } from "./issue-analyst.js";
import { IssueLabeler } from "./issue-labeler.js";
import { parseIssueDirectiveScope, type IssueDirectiveScope } from "./issue-directives.js";
import { IssuePlanner } from "./issue-planner.js";
import { IssueRunner } from "./issue-runner.js";
import { getIssueRunPath, loadIssueConversation, saveIssueConversation, saveIssuePlan } from "./issue-state.js";
import { createJobManager } from "./job-manager.js";
import { loadRepoAgentsPreferences, saveRepoAgentsPreferences } from "./repo-agents.js";
import type { JobState } from "./types.js";
import { readTaskFromJson } from "./validation.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

function printUsage(): void {
  console.log(`FelixAI Orchestrator

Usage:
  felixai
  felixai shell
  felixai auth login
  felixai auth status
  felixai auth logout
  felixai doctor
  felixai init [--force]
  felixai config show
  felixai config set reasoning-effort <minimal|low|medium|high|xhigh> [--repo <path>]
  felixai config set model <model-name> [--repo <path>]
  felixai config set turbo-mode <enabled|disabled> [--repo <path>]
  felixai config set encourage-subagents <enabled|disabled> [--repo <path>]
  felixai issues snapshot --repo <path> [--json]
  felixai issues plan --repo <path> [--directive "<text>"] [--json]
  felixai issues run --repo <path> [--directive "<text>"] [--json]
  felixai session watch <session-id> [--raw] [--lines <n>] [--no-follow]
  felixai version
  felixai job start --repo <path> (--task "<large task>" | --task-file <file>) [--base-branch <branch>] [--parallel <n>] [--auto-resume] [--require-clean] [--issue <id>]
  felixai job status <job-id> [--json]
  felixai job watch <job-id> [--work-item <id>] [--raw] [--lines <n>] [--no-follow]
  felixai job resume <job-id>
  felixai job push <job-id> [--work-item <id>] [--remote <name>]
  felixai job merge <job-id> [--work-item <id>] [--target-branch <branch>] [--json]
  felixai job pr <job-id> [--work-item <id>] [--base-branch <branch>] [--no-draft] [--json]
  felixai job resolve-conflicts <job-id> [--session <id>] [--json]
  felixai job list [--json]

Examples:
  felixai
  felixai shell
  felixai auth login
  felixai auth status
  felixai doctor
  felixai init
  felixai config show
  felixai config set reasoning-effort medium
  felixai config set model gpt-5.4 --repo .
  felixai config set turbo-mode enabled --repo .
  felixai issues snapshot --repo .
  felixai issues plan --repo . --directive "Review unfinished issues and choose the safest implementation order"
  felixai issues run --repo . --directive "Review unfinished issues and start processing them in dependency order"
  felixai session watch 019d76f8-17ba-7ba3-bb0c-46a7fbe09bb8
  felixai review all github issues and plan the best order
  felixai job start --repo . --task "Build the next milestone"
  felixai job watch <job-id>
  felixai job start --repo . --task-file ./felixai.task.json --parallel 3 --auto-resume
  felixai job start --repo . --task "Refactor auth" --require-clean
  felixai job start --repo . --task "Implement GH issue" --issue 142 --issue api-hardening
  felixai job push <job-id>
  felixai job merge <job-id> --target-branch main
  felixai job pr <job-id>
  felixai job resolve-conflicts <job-id>
`);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value '${value}'.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value '${value}'.`);
  }

  return parsed;
}

function getMultiFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        values.push(next);
      }
    }
  }
  return values;
}

function summarizeJob(job: JobState): {
  pending: number;
  running: number;
  boundary: number;
  blocked: number;
  completed: number;
  failed: number;
} {
  return job.workItems.reduce(
    (summary, item) => {
      summary[item.status] += 1;
      return summary;
    },
    {
      pending: 0,
      running: 0,
      boundary: 0,
      blocked: 0,
      completed: 0,
      failed: 0
    }
  );
}

function inferJobPhase(job: JobState): string | undefined {
  const candidates = [job.task, ...job.workItems.map((item) => item.prompt)];
  for (const candidate of candidates) {
    const match = candidate.match(/Execution phase:\s*(implementation|validation)/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

function formatJobListBlock(job: JobState, taskSummary: string): string {
  const summary = summarizeJob(job);
  const primarySessionId =
    job.sessions.find((session) => session.status === "running")?.sessionId ??
    job.sessions.find((session) => Boolean(session.sessionId))?.sessionId;
  const phase = inferJobPhase(job);
  const issueRefs = job.issueRefs.length > 0 ? job.issueRefs.map((issue) => `#${issue}`).join(", ") : "none";
  const lines = [
    `Job ID: ${job.jobId}`,
    `  Status: ${job.status}`,
    `  Branch: ${job.baseBranch}`,
    `  Issues: ${issueRefs}`,
    `  Work Items: done=${summary.completed}/${job.workItems.length} running=${summary.running} failed=${summary.failed}`,
    `  Task: ${taskSummary}`
  ];

  if (primarySessionId) {
    lines.splice(4, 0, `  Session: ${primarySessionId}`);
  }
  if (phase) {
    lines.splice(primarySessionId ? 5 : 4, 0, `  Phase: ${phase}`);
  }

  return lines.join("\n");
}

function isBranchDriftError(message: string | undefined): boolean {
  return typeof message === "string" && /branch drift detected/i.test(message);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function findRepoInstructionsPath(job: JobState): string | undefined {
  const event = job.events.find((entry) => /Loaded repository instructions from /i.test(entry.message));
  if (!event) {
    return undefined;
  }

  return event.message.replace(/^.*Loaded repository instructions from /i, "").replace(/\.$/, "");
}

function isReasoningEffort(value: string): value is ModelReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function parseBooleanSetting(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "enabled", "enable", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "disabled", "disable", "0"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean-style value '${value}'. Use enabled/disabled, true/false, on/off, yes/no, or 1/0.`);
}

async function resolveRepoRoot(repoPath: string): Promise<string> {
  await assertGitRepository(repoPath);
  return resolveGitRoot(repoPath);
}

interface IssueConversationState {
  repoRoot: string;
  updatedAt: string;
  lastIssueAnalysis?: PriorIssueAnalysisContext;
}

async function loadIssueConversationState(repoRoot: string): Promise<IssueConversationState | undefined> {
  try {
    return await loadIssueConversation<IssueConversationState>(repoRoot, repoRoot);
  } catch {
    return undefined;
  }
}

async function saveIssueConversationState(repoRoot: string, state: IssueConversationState): Promise<void> {
  await saveIssueConversation(repoRoot, repoRoot, state);
}

function filterIssuesByScope<T extends { number: number; labels: string[] }>(issues: T[], scope: IssueDirectiveScope): T[] {
  return issues.filter((issue) => {
    const matchesIssueNumbers = scope.issueNumbers.length === 0 || scope.issueNumbers.includes(issue.number);
    const matchesLabels = scope.labelFilters.length === 0 || scope.labelFilters.some((label) => issue.labels.includes(label));
    return matchesIssueNumbers && matchesLabels;
  });
}

async function resolveIntentForPrompt(command: string, rest: string[], repoRoot: string): Promise<{
  sessionId?: string;
  intent: Awaited<ReturnType<IntentParser["parse"]>>["intent"];
}> {
  const promptText = [command, ...rest].join(" ").trim();
  const conversation = await loadIssueConversationState(repoRoot);
  const { snapshot } = await snapshotUnfinishedGitHubIssues(repoRoot, repoRoot);
  const config = await loadConfig(repoRoot);
  const repoPreferences = await loadRepoAgentsPreferences(repoRoot);
  const parser = new IntentParser(config);
  return parser.parse({
    userPrompt: promptText,
    repoRoot,
    issueSnapshot: snapshot.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      labels: issue.labels
    })),
    priorIssueAnalysis: conversation?.lastIssueAnalysis,
    model: repoPreferences?.model,
    modelReasoningEffort: repoPreferences?.reasoningEffort,
    turboMode: repoPreferences?.turboMode,
    encourageSubagents: repoPreferences?.encourageSubagents
  });
}

async function runNaturalLanguageIssueDirective(
  command: string,
  rest: string[],
  options?: { scope?: IssueDirectiveScope; requiresConfirmation?: boolean; rl?: ReadlineInterface }
): Promise<void> {
  const directive = [command, ...rest].join(" ").trim();
  const repoRoot = await resolveRepoRoot(process.cwd());
  await ensureRepoModelPreference(repoRoot);
  if (options?.requiresConfirmation && process.stdin.isTTY && process.stdout.isTTY) {
    const plan = await previewIssueExecutionPlan(repoRoot, directive);
    console.log(`[felixai] proposed issue plan: ${plan.summary}`);
    for (const item of plan.orderedIssues) {
      const dependsOn = item.dependsOn.length > 0 ? item.dependsOn.map((issue) => `#${issue}`).join(", ") : "none";
      console.log(
        `[felixai] plan #${item.issueNumber}: ${item.title} parallel_safe=${item.parallelSafe ? "yes" : "no"} overlap=${item.overlapRisk} depends_on=${dependsOn}`
      );
    }
    const approved = await promptYesNo("[felixai] Implement this plan now? (yes/no): ", options.rl);
    if (!approved) {
      console.log("[felixai] issue plan not executed.");
      return;
    }
  }
  if (process.stdout.isTTY) {
    printBusyExecutionNotice(repoRoot, options?.scope);
  }
  const runner = new IssueRunner(repoRoot);
  const run = await runner.run({ repoRoot, directive, scope: options?.scope });
  console.log(`[felixai] issue run: ${run.runPath ?? "saved"}`);
  console.log(`[felixai] status: ${run.status}`);
  console.log(`[felixai] summary: ${run.summary}`);
  for (const issue of run.issues) {
    console.log(
      `[felixai] issue #${issue.issueNumber}: ${issue.status} jobs=${issue.jobIds.length} parallel_safe=${issue.parallelSafe ? "yes" : "no"} overlap=${issue.overlapRisk}`
    );
  }
}

async function runNaturalLanguageIssueAnalysisDirective(
  command: string,
  rest: string[],
  options?: { scope?: IssueDirectiveScope; topN?: number; rl?: ReadlineInterface; autoApproveImplementation?: boolean }
): Promise<void> {
  const directive = [command, ...rest].join(" ").trim();
  const repoRoot = await resolveRepoRoot(process.cwd());
  await ensureRepoModelPreference(repoRoot);
  const conversation = await loadIssueConversationState(repoRoot);
  const { snapshot } = await snapshotUnfinishedGitHubIssues(repoRoot, repoRoot);
  const scope = options?.scope ?? parseIssueDirectiveScope(command, rest);
  const filteredIssues = filterIssuesByScope(snapshot.issues, scope);
  if (filteredIssues.length === 0) {
    throw new Error("No unfinished GitHub issues matched the requested issue numbers and labels.");
  }

  const config = await loadConfig(repoRoot);
  const repoPreferences = await loadRepoAgentsPreferences(repoRoot);
  const analyst = new IssueAnalyst(config);
  const analysis = await analyst.analyze({
    directive,
    repoRoot,
    issues: filteredIssues,
    topN: options?.topN,
    priorIssueAnalysis: conversation?.lastIssueAnalysis,
    model: repoPreferences?.model,
    modelReasoningEffort: repoPreferences?.reasoningEffort,
    turboMode: repoPreferences?.turboMode,
    encourageSubagents: repoPreferences?.encourageSubagents
  });

  await saveIssueConversationState(repoRoot, {
    repoRoot,
    updatedAt: new Date().toISOString(),
    lastIssueAnalysis: {
      summary: analysis.result.summary,
      recommendedIssueNumbers: analysis.result.recommendedIssueNumbers,
      filteredIssueNumbers: filteredIssues.map((issue) => issue.number)
    }
  });

  if (analysis.sessionId) {
    console.log(`[felixai] session: ${analysis.sessionId}`);
  }
  console.log(analysis.result.summary);
  for (const issueNumber of analysis.result.recommendedIssueNumbers) {
    const issue = filteredIssues.find((entry) => entry.number === issueNumber);
    if (issue) {
      console.log(`[felixai] recommended #${issue.number}: ${issue.title}`);
    }
  }

  if (analysis.result.isImplementationPlan) {
    const implementationScope: IssueDirectiveScope = {
      issueNumbers: analysis.result.implementationIssueNumbers,
      labelFilters: [],
      implementFirstOnly: false
    };
    const shouldExecute =
      options?.autoApproveImplementation ??
      (process.stdin.isTTY && process.stdout.isTTY
        ? await promptYesNo("[felixai] Implement this now? (yes/no): ", options?.rl)
        : false);

    if (shouldExecute) {
      await runNaturalLanguageIssueDirective(command, rest, {
        scope: implementationScope,
        requiresConfirmation: false,
        rl: options?.rl
      });
    }
  }
}

async function runNaturalLanguageIssueLabelingDirective(command: string, rest: string[]): Promise<void> {
  const directive = [command, ...rest].join(" ").trim();
  const repoRoot = await resolveRepoRoot(process.cwd());
  await ensureRepoModelPreference(repoRoot);
  const { snapshot } = await snapshotUnfinishedGitHubIssues(repoRoot, repoRoot);
  const config = await loadConfig(repoRoot);
  const repoPreferences = await loadRepoAgentsPreferences(repoRoot);
  const labeler = new IssueLabeler(config);
  const plan = await labeler.createLabelingPlan({
    directive,
    repoRoot,
    issues: snapshot.issues,
    model: repoPreferences?.model,
    modelReasoningEffort: repoPreferences?.reasoningEffort,
    turboMode: repoPreferences?.turboMode,
    encourageSubagents: repoPreferences?.encourageSubagents
  });

  for (const label of plan.result.labels) {
    await ensureGitHubLabel({
      repoPath: repoRoot,
      name: label.name,
      color: label.color,
      description: label.description
    });
  }

  console.log(`[felixai] session: ${plan.sessionId ?? "n/a"}`);
  console.log(plan.result.summary);

  for (const assignment of plan.result.assignments) {
    const existing = snapshot.issues.find((issue) => issue.number === assignment.issueNumber)?.labels ?? [];
    const labelsToAdd = assignment.labels.filter((label) => !existing.includes(label));
    await addLabelsToGitHubIssue({
      repoPath: repoRoot,
      issueNumber: assignment.issueNumber,
      labels: labelsToAdd
    });

    console.log(
      `[felixai] issue #${assignment.issueNumber}: ${assignment.title} -> ${assignment.labels.length > 0 ? assignment.labels.join(", ") : "no labels"}`
    );
  }
}

async function runNaturalLanguageRepoPrompt(command: string, rest: string[]): Promise<void> {
  const promptText = [command, ...rest].join(" ").trim();
  const repoRoot = await resolveRepoRoot(process.cwd());
  await ensureRepoModelPreference(repoRoot);
  const config = await loadConfig(repoRoot);
  const repoPreferences = await loadRepoAgentsPreferences(repoRoot);
  const adapter = new CodexAdapter(config);
  const input = [
    "You are answering a direct natural-language FelixAI request for the current repository.",
    "Inspect the repository as needed and answer the user's request directly.",
    "Prefer concise, concrete repo-aware output.",
    repoPreferences ? `Repository instructions file: ${repoPreferences.path}\n${repoPreferences.content}` : undefined,
    `User request: ${promptText}`
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const result = await adapter.runPrompt({
    prompt: input,
    workspacePath: repoRoot,
    model: repoPreferences?.model,
    modelReasoningEffort: repoPreferences?.reasoningEffort,
    turboMode: repoPreferences?.turboMode,
    encourageSubagents: repoPreferences?.encourageSubagents
  });
  if (result.sessionId) {
    console.log(`[felixai] session: ${result.sessionId}`);
  }
  console.log(result.response.trim());
}

async function prompt(question: string, rl?: ReadlineInterface): Promise<string> {
  if (rl) {
    return (await rl.question(question)).trim();
  }

  const localRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return (await localRl.question(question)).trim();
  } finally {
    localRl.close();
  }
}

async function promptYesNo(question: string, rl?: ReadlineInterface): Promise<boolean> {
  while (true) {
    const answer = (await prompt(question, rl)).trim().toLowerCase();
    if (["y", "yes"].includes(answer)) {
      return true;
    }
    if (["n", "no"].includes(answer)) {
      return false;
    }
    console.log(`[felixai] Invalid selection '${answer}'. Enter yes or no.`);
  }
}

async function runSessionWatch(args: string[]): Promise<void> {
  const sessionId = requireValue(args[0], "Missing session id.");
  const raw = hasFlag(args, "--raw");
  const follow = !hasFlag(args, "--no-follow");
  const lines = parseNonNegativeInteger(getFlagValue(args, "--lines")) ?? 40;
  const transcriptPath = await findCodexSessionTranscript(sessionId);
  if (!transcriptPath) {
    throw new Error(`No Codex transcript was found for session '${sessionId}'.`);
  }

  console.log(`[felixai] transcript: ${transcriptPath}`);
  if (follow) {
    console.log("[felixai] transcript mode: follow");
  }
  await watchTranscript(transcriptPath, { raw, follow, lineCount: lines });
}

async function resolveJobWatchSession(jobId: string, workItemId?: string): Promise<{ workItemId: string; sessionId: string }> {
  const manager = await createJobManager();
  const job = await manager.getJob(jobId);
  const startingItem = job.workItems.find((item) => {
    if (workItemId && item.id !== workItemId) {
      return false;
    }
    return item.status === "running" && !item.sessionId;
  });
  const candidateSessions = job.sessions.filter((session) => {
    if (!session.sessionId) {
      return false;
    }
    return workItemId ? session.workItemId === workItemId : true;
  });

  if (candidateSessions.length === 0) {
    if (startingItem) {
      throw new Error(
        workItemId
          ? `Work item '${workItemId}' is still starting; no Codex session has been established yet.`
          : `Job '${jobId}' is still starting; no Codex session has been established yet.`
      );
    }
    throw new Error(workItemId ? `No session found for work item '${workItemId}'.` : `No sessions found for job '${jobId}'.`);
  }

  const preferred =
    candidateSessions.find((session) => {
      const item = job.workItems.find((entry) => entry.id === session.workItemId);
      return item?.status === "running";
    }) ??
    candidateSessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  return {
    workItemId: preferred?.workItemId ?? candidateSessions[0]!.workItemId,
    sessionId: preferred?.sessionId ?? candidateSessions[0]!.sessionId!
  };
}

async function runJobWatch(args: string[]): Promise<void> {
  const jobId = requireValue(args[0], "Missing job id.");
  const workItemId = getFlagValue(args.slice(1), "--work-item");
  const raw = hasFlag(args, "--raw");
  const follow = !hasFlag(args, "--no-follow");
  const lines = parseNonNegativeInteger(getFlagValue(args, "--lines")) ?? 40;
  const resolved = await resolveJobWatchSession(jobId, workItemId);
  console.log(`[felixai] watching ${resolved.workItemId} session=${resolved.sessionId}`);
  await runSessionWatch([resolved.sessionId, ...(raw ? ["--raw"] : []), ...(follow ? [] : ["--no-follow"]), "--lines", String(lines)]);
}

function describeIssueExecutionScope(scope: IssueDirectiveScope | undefined): string {
  if (!scope) {
    return "full planned issue scope";
  }

  const parts: string[] = [];
  if (scope.issueNumbers.length > 0) {
    parts.push(`issues=${scope.issueNumbers.map((issueNumber) => `#${issueNumber}`).join(", ")}`);
  }
  if (scope.labelFilters.length > 0) {
    parts.push(`labels=${scope.labelFilters.join(", ")}`);
  }
  if (scope.implementFirstOnly) {
    parts.push("mode=first-match-only");
  }

  return parts.length > 0 ? parts.join(" ") : "full planned issue scope";
}

function printBusyExecutionNotice(repoRoot: string, scope: IssueDirectiveScope | undefined): void {
  console.log(`[felixai] execution starting: ${describeIssueExecutionScope(scope)}`);
  console.log(`[felixai] issue run state: ${getIssueRunPath(repoRoot, repoRoot)}`);
  console.log("[felixai] shell mode: busy");
  console.log("[felixai] use another shell for status:");
  console.log("[felixai]   felixai job list");
  console.log("[felixai]   felixai job status <job-id>");
}

function tokenizeShellInput(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

async function previewIssueExecutionPlan(repoRoot: string, directive: string): Promise<{
  summary: string;
  orderedIssues: Array<{ issueNumber: number; title: string; dependsOn: number[]; parallelSafe: boolean; overlapRisk: "low" | "medium" | "high" }>;
}> {
  const scope = parseIssueDirectiveScope("issues", [directive]);
  const { snapshot } = await snapshotUnfinishedGitHubIssues(repoRoot, repoRoot);
  const filteredIssues = snapshot.issues.filter((issue) => {
    const matchesIssueNumbers = scope.issueNumbers.length === 0 || scope.issueNumbers.includes(issue.number);
    const matchesLabels = scope.labelFilters.length === 0 || scope.labelFilters.some((label) => issue.labels.includes(label));
    return matchesIssueNumbers && matchesLabels;
  });

  if (filteredIssues.length === 0) {
    throw new Error("No unfinished GitHub issues matched the requested issue numbers and labels.");
  }

  const config = await loadConfig(repoRoot);
  const repoPreferences = await loadRepoAgentsPreferences(repoRoot);
  const planner = new IssuePlanner(config);
  const plan = await planner.createIssuePlan({
    directive,
    repoRoot,
    issues: filteredIssues,
    model: repoPreferences?.model,
    modelReasoningEffort: repoPreferences?.reasoningEffort,
    turboMode: repoPreferences?.turboMode,
    encourageSubagents: repoPreferences?.encourageSubagents
  });

  return plan;
}

async function printShellHeader(): Promise<void> {
  try {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const preferences = await loadRepoAgentsPreferences(repoRoot);
    const config = await loadConfig(repoRoot);
    const { snapshot } = await snapshotUnfinishedGitHubIssues(repoRoot, repoRoot).catch(() => ({ snapshot: undefined as never }));
    const remoteName = await getPreferredRemote(repoRoot).catch(() => undefined);
    const remoteUrl = remoteName ? await getRemoteUrl(repoRoot, remoteName).catch(() => undefined) : undefined;
    const repoLabel = remoteUrl?.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "") ?? repoRoot;
    const model = preferences?.model ?? "prompt per repo";
    const reasoning = preferences?.reasoningEffort ?? config.codex.modelReasoningEffort;
    const cardWidth = 70;
    const border = "┌" + "─".repeat(cardWidth - 2) + "┐";
    const footer = "└" + "─".repeat(cardWidth - 2) + "┘";
    const line = (label: string, value: string): string => {
      const content = `${label} ${value}`;
      const trimmed = content.length > cardWidth - 4 ? `${content.slice(0, cardWidth - 7)}...` : content;
      return `│ ${trimmed.padEnd(cardWidth - 4, " ")} │`;
    };

    console.log(border);
    console.log(line(">_ FelixAI", `(v${packageJson.version})`));
    console.log(line("model:", `${model} ${reasoning}`.trim()));
    console.log(line("repo:", repoLabel));
    if (snapshot) {
      console.log(line("open issues:", String(snapshot.issues.length)));
    }
    console.log(footer);
  } catch {
    const config = await loadConfig();
    const cardWidth = 70;
    const border = "┌" + "─".repeat(cardWidth - 2) + "┐";
    const footer = "└" + "─".repeat(cardWidth - 2) + "┘";
    const line = (label: string, value: string): string =>
      `│ ${`${label} ${value}`.padEnd(cardWidth - 4, " ")} │`;
    console.log(border);
    console.log(line(">_ FelixAI", `(v${packageJson.version})`));
    console.log(line("model:", `prompt per repo ${config.codex.modelReasoningEffort}`));
    console.log(line("repo:", "not inside a git repository"));
    console.log(footer);
  }
}

async function reconcileShellStartupJobs(): Promise<void> {
  try {
    const repoRoot = await resolveRepoRoot(process.cwd());
    const manager = await createJobManager();
    const archived = await manager.archiveStaleActiveJobs({
      repoRoot,
      staleAfterMs: 15 * 60_000
    });
    if (archived.length > 0) {
      const jobList = archived.map((job) => job.jobId).join(", ");
      console.log(`[felixai] archived stale jobs: ${jobList}`);
    }
  } catch {
    // Shell startup should still work outside a repo or if cleanup cannot run.
  }
}

async function promptForModelSelection(
  repoRoot: string,
  catalog: CodexModelCatalogEntry[],
  currentCodexModel?: string
): Promise<string> {
  if (catalog.length === 0) {
    let manual = "";
    while (!manual) {
      manual = await prompt(`[felixai] Enter the Codex model for ${repoRoot}: `);
    }
    return normalizeCodexModelSlug(manual);
  }

  console.log(`[felixai] Select the Codex model for ${repoRoot}:`);
  for (const [index, entry] of catalog.entries()) {
    const markers: string[] = [];
    if (entry.slug === currentCodexModel) {
      markers.push("Current");
    }
    if (index === 0 && entry.slug !== currentCodexModel) {
      markers.push("Recommended");
    }
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
    console.log(`[felixai]   ${index + 1}. ${entry.slug}${suffix}`);
  }

  while (true) {
    const raw = await prompt(`[felixai] Choose 1-${catalog.length}: `);
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= catalog.length) {
      return catalog[parsed - 1]?.slug as string;
    }
    console.log(`[felixai] Invalid selection '${raw}'.`);
  }
}

async function promptAndSaveRepoModel(repoRoot: string, reason?: string): Promise<void> {
  const catalog = await loadCodexModelCatalog();
  const currentCodexModel = await loadCurrentCodexModel();
  if (reason) {
    console.log(`[felixai] ${reason}`);
  }
  const model = await promptForModelSelection(repoRoot, catalog, currentCodexModel);
  const saved = await saveRepoAgentsPreferences(repoRoot, { model });
  console.log(`[felixai] saved repo model: ${saved.model}`);
  console.log(`[felixai] repo instructions: ${saved.path}`);
}

function buildUnsupportedRepoModelMessage(
  model: string,
  currentCodexModel: string | undefined,
  source: "catalog" | "runtime"
): string {
  const current = currentCodexModel ? ` Current Codex CLI model: '${currentCodexModel}'.` : "";
  if (source === "catalog") {
    return `The saved repo model '${model}' is not present in Codex's current local model catalog.${current}`;
  }

  return `The saved repo model '${model}' failed at runtime even though it appears in Codex's local model catalog.${current}`;
}

async function validateRequestedRepoModel(repoRoot: string, model: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const catalog = await loadCodexModelCatalog();
  const normalized = normalizeCodexModelSlug(model);
  if (!findCodexModelEntry(catalog, normalized)) {
    throw new Error(`Model '${model}' is not present in Codex's current local model catalog.`);
  }

  const adapter = new CodexAdapter(config);
  try {
    await adapter.runPrompt({
      prompt: "Reply with OK.",
      workspacePath: repoRoot,
      model: normalized
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

async function ensureRepoModelPreference(repoPath: string): Promise<void> {
  const repoRoot = await resolveRepoRoot(repoPath);
  const preferences = await loadRepoAgentsPreferences(repoRoot);
  if (preferences?.model) {
    const config = await loadConfig(repoRoot);
    const normalizedModel = normalizeCodexModelSlug(preferences.model);
    const catalog = await loadCodexModelCatalog();
    const currentCodexModel = await loadCurrentCodexModel();
    const matching = findCodexModelEntry(catalog, normalizedModel);
    if (!matching) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          `Repository '${repoRoot}' defines a model '${preferences.model}' that is not present in Codex's current local model catalog.`
        );
      }

      await promptAndSaveRepoModel(repoRoot, buildUnsupportedRepoModelMessage(preferences.model, currentCodexModel, "catalog"));
      return;
    }

    if (preferences.model !== normalizedModel) {
      const saved = await saveRepoAgentsPreferences(repoRoot, { model: normalizedModel });
      console.log(`[felixai] normalized repo model: ${saved.model}`);
      console.log(`[felixai] repo instructions: ${saved.path}`);
    }

    const adapter = new CodexAdapter(config);
    try {
      await adapter.runPrompt({
        prompt: "Reply with OK.",
        workspacePath: repoRoot,
        model: normalizedModel
      });
      return;
    } catch {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          `Repository '${repoRoot}' defines an unsupported Codex model '${preferences.model}' in AGENTS.md. Update that model or remove the model line.`
        );
      }

      await promptAndSaveRepoModel(repoRoot, buildUnsupportedRepoModelMessage(preferences.model, currentCodexModel, "runtime"));
      return;
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Repository '${repoRoot}' does not define a FelixAI model in AGENTS.md. Run 'felixai config set model <model> --repo "${repoRoot}"' first.`
    );
  }

  await promptAndSaveRepoModel(repoRoot);
}

async function printRepoPreferences(repoRoot: string, options?: { includePath?: boolean }): Promise<void> {
  const preferences = await loadRepoAgentsPreferences(repoRoot);
  if (!preferences) {
    return;
  }

  if (options?.includePath ?? true) {
    console.log(`[felixai] repo instructions: ${preferences.path}`);
  }
  if (preferences.model) {
    console.log(`[felixai] repo model: ${preferences.model}`);
  }
  if (preferences.reasoningEffort) {
    console.log(`[felixai] repo reasoning effort: ${preferences.reasoningEffort}`);
  }
  if (preferences.turboMode !== undefined) {
    console.log(`[felixai] repo turbo mode: ${preferences.turboMode ? "enabled" : "disabled"}`);
  }
  if (preferences.encourageSubagents !== undefined) {
    console.log(`[felixai] repo encourage subagents: ${preferences.encourageSubagents ? "enabled" : "disabled"}`);
  }
}

async function startFelixShell(): Promise<void> {
  await reconcileShellStartupJobs();
  console.log("[felixai] interactive mode. Type 'exit' to leave.");
  await printShellHeader();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    while (true) {
      const line = (await rl.question("felixai> ")).trim();
      if (!line) {
        continue;
      }
      if (["exit", "quit"].includes(line.toLowerCase())) {
        return;
      }
      if (line.toLowerCase() === "help") {
        printUsage();
        continue;
      }

      try {
        await handleArgs(tokenizeShellInput(line), rl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[felixai] ${message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function handleArgs(args: string[], rl?: ReadlineInterface): Promise<void> {
  const command = args[0];

  if (!command || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printUsage();
    return;
  }

  const rest = args.slice(1);
  if (!["init", "auth", "doctor", "config", "issues", "session", "version", "job", "shell"].includes(command)) {
    const repoRoot = await resolveRepoRoot(process.cwd());
    await ensureRepoModelPreference(repoRoot);
    const resolved = await resolveIntentForPrompt(command, rest, repoRoot);
    const scope: IssueDirectiveScope = {
      issueNumbers: resolved.intent.issueNumbers,
      labelFilters: resolved.intent.labelFilters,
      implementFirstOnly: resolved.intent.implementFirstOnly
    };

    if (resolved.intent.mode === "issue_labeling") {
      await runNaturalLanguageIssueLabelingDirective(command, rest);
      return;
    }
    if (resolved.intent.mode === "issue_analysis" || resolved.intent.requiresConfirmation) {
      await runNaturalLanguageIssueAnalysisDirective(command, rest, {
        scope,
        topN: resolved.intent.topN,
        rl
      });
      return;
    }
    if (resolved.intent.mode === "issue_execution") {
      await runNaturalLanguageIssueDirective(command, rest, {
        scope,
        requiresConfirmation: resolved.intent.requiresConfirmation,
        rl
      });
      return;
    }
    await runNaturalLanguageRepoPrompt(command, rest);
    return;
  }
  const force = hasFlag(rest, "--force");

  switch (command) {
    case "init": {
      const result = await initializeProject({ force });
      console.log("[felixai] initialized FelixAI Orchestrator project files");
      for (const entry of result.created) {
        console.log(`[felixai] created ${entry}`);
      }
      for (const entry of result.skipped) {
        console.log(`[felixai] skipped existing ${entry}`);
      }
      return;
    }
    case "auth": {
      const authCommand = rest[0];
      switch (authCommand) {
        case "login": {
          await loginWithCodex();
          const status = await getCodexAuthStatus();
          console.log(`[felixai] Codex login active: ${status.loggedIn ? "yes" : "no"}`);
          if (status.email) {
            console.log(`[felixai] account: ${status.email}`);
          }
          return;
        }
        case "status": {
          const status = await getCodexAuthStatus();
          console.log(`[felixai] Codex login active: ${status.loggedIn ? "yes" : "no"}`);
          if (status.email) {
            console.log(`[felixai] account: ${status.email}`);
          }
          if (status.userId) {
            console.log(`[felixai] user id: ${status.userId}`);
          }
          console.log(`[felixai] auth store: ${status.authFilePath}`);
          if (status.rawStatus) {
            console.log(`[felixai] codex status: ${status.rawStatus}`);
          }
          return;
        }
        case "logout": {
          await logoutFromCodex();
          console.log("[felixai] Codex login removed.");
          return;
        }
        default:
          throw new Error(`Unknown auth subcommand '${authCommand ?? ""}'. Use 'login', 'status', or 'logout'.`);
      }
    }
    case "doctor": {
      const report = await runDoctor(process.cwd());
      console.log(`[felixai] doctor status: ${report.overallStatus}`);
      for (const check of report.checks) {
        console.log(`[felixai] ${check.id}: ${check.status} ${check.summary}`);
        if (check.detail) {
          console.log(`[felixai] ${check.id} detail: ${check.detail}`);
        }
      }
      return;
    }
    case "config": {
      const configCommand = rest[0];
      if (configCommand === "show") {
        const config = await loadConfig();
        console.log(`[felixai] credential source: ${config.credentialSource}`);
        console.log(`[felixai] state dir: ${config.stateDir}`);
        console.log(`[felixai] workspace root: ${config.workspaceRoot}`);
        console.log(`[felixai] log dir: ${config.logDir}`);
        console.log(`[felixai] sandbox mode: ${config.codex.sandboxMode}`);
        console.log(`[felixai] approval policy: ${config.codex.approvalPolicy}`);
        console.log(`[felixai] reasoning effort default: ${config.codex.modelReasoningEffort}`);
        console.log("[felixai] model default: prompt per repo until AGENTS.md sets model");
        console.log(`[felixai] parallelism: ${config.codex.parallelism}`);
        console.log(`[felixai] auto resume: ${config.codex.autoResume}`);

        try {
          const repoRoot = await resolveRepoRoot(process.cwd());
          await printRepoPreferences(repoRoot);
        } catch {
          // Config show should still work outside a git repository.
        }
        return;
      }

      if (configCommand === "set") {
        const settingName = requireValue(rest[1], "Missing config setting name.");
        const settingValue = requireValue(rest[2], "Missing config setting value.");
        const repoFlagValue = getFlagValue(rest.slice(3), "--repo");

        if (settingName === "reasoning-effort") {
          if (!isReasoningEffort(settingValue)) {
            throw new Error(`Invalid reasoning effort '${settingValue}'. Use minimal, low, medium, high, or xhigh.`);
          }

          if (repoFlagValue) {
            const repoRoot = await resolveRepoRoot(path.resolve(repoFlagValue));
            const saved = await saveRepoAgentsPreferences(repoRoot, { reasoningEffort: settingValue });
            console.log(`[felixai] repo reasoning effort: ${saved.reasoningEffort}`);
            console.log(`[felixai] repo instructions: ${saved.path}`);
            return;
          }

          const config = await loadConfig();
          config.codex.modelReasoningEffort = settingValue;
          await saveConfig(config);
          console.log(`[felixai] default reasoning effort: ${config.codex.modelReasoningEffort}`);
          return;
        }

        if (settingName === "model") {
          const repoRoot = await resolveRepoRoot(path.resolve(repoFlagValue ?? process.cwd()));
          await validateRequestedRepoModel(repoRoot, settingValue);
          const saved = await saveRepoAgentsPreferences(repoRoot, { model: settingValue });
          console.log(`[felixai] repo model: ${saved.model}`);
          console.log(`[felixai] repo instructions: ${saved.path}`);
          return;
        }

        if (settingName === "turbo-mode") {
          const repoRoot = await resolveRepoRoot(path.resolve(repoFlagValue ?? process.cwd()));
          const saved = await saveRepoAgentsPreferences(repoRoot, { turboMode: parseBooleanSetting(settingValue) });
          console.log(`[felixai] repo turbo mode: ${saved.turboMode ? "enabled" : "disabled"}`);
          console.log(`[felixai] repo instructions: ${saved.path}`);
          return;
        }

        if (settingName === "encourage-subagents") {
          const repoRoot = await resolveRepoRoot(path.resolve(repoFlagValue ?? process.cwd()));
          const saved = await saveRepoAgentsPreferences(repoRoot, { encourageSubagents: parseBooleanSetting(settingValue) });
          console.log(`[felixai] repo encourage subagents: ${saved.encourageSubagents ? "enabled" : "disabled"}`);
          console.log(`[felixai] repo instructions: ${saved.path}`);
          return;
        }

        throw new Error(`Unknown config setting '${settingName}'. Use 'reasoning-effort', 'model', 'turbo-mode', or 'encourage-subagents'.`);
      }

      throw new Error(`Unknown config subcommand '${configCommand ?? ""}'. Use 'show' or 'set'.`);
    }
    case "issues": {
      const issuesCommand = rest[0];
      const issuesArgs = rest.slice(1);

      switch (issuesCommand) {
        case "snapshot": {
          const repoPath = path.resolve(requireValue(getFlagValue(issuesArgs, "--repo"), "Missing --repo value."));
          const repoRoot = await resolveRepoRoot(repoPath);
          const { snapshot, outputPath } = await snapshotUnfinishedGitHubIssues(repoRoot, repoRoot);
          if (hasFlag(issuesArgs, "--json")) {
            console.log(JSON.stringify(snapshot, null, 2));
            return;
          }

          console.log(`[felixai] issue snapshot saved: ${outputPath}`);
          console.log(`[felixai] unfinished issues: ${snapshot.issues.length}`);
          for (const issue of snapshot.issues) {
            console.log(`[felixai] issue #${issue.number}: ${issue.title}`);
          }
          return;
        }
        case "plan": {
          const repoPath = path.resolve(requireValue(getFlagValue(issuesArgs, "--repo"), "Missing --repo value."));
          const repoRoot = await resolveRepoRoot(repoPath);
          await ensureRepoModelPreference(repoRoot);
          const directive =
            getFlagValue(issuesArgs, "--directive") ??
            "Review unfinished GitHub issues and determine the safest order to complete them, including dependencies and parallel-safe work.";
          const { snapshot, outputPath: snapshotPath } = await snapshotUnfinishedGitHubIssues(repoRoot, repoRoot);
          const config = await loadConfig(repoRoot);
          const repoPreferences = await loadRepoAgentsPreferences(repoRoot);
          const planner = new IssuePlanner(config);
          const plan = await planner.createIssuePlan({
            directive,
            repoRoot,
            issues: snapshot.issues,
            model: repoPreferences?.model,
            modelReasoningEffort: repoPreferences?.reasoningEffort,
            turboMode: repoPreferences?.turboMode,
            encourageSubagents: repoPreferences?.encourageSubagents
          });
          const planDocument = {
            repoRoot,
            generatedAt: new Date().toISOString(),
            directive,
            snapshotPath,
            orderedIssues: plan.orderedIssues,
            summary: plan.summary
          };
          const planPath = await saveIssuePlan(repoRoot, repoRoot, planDocument);

          if (hasFlag(issuesArgs, "--json")) {
            console.log(JSON.stringify(planDocument, null, 2));
            return;
          }

          console.log(`[felixai] issue plan saved: ${planPath}`);
          console.log(`[felixai] issue snapshot: ${snapshotPath}`);
          console.log(`[felixai] issue plan summary: ${plan.summary}`);
          for (const item of plan.orderedIssues) {
            const dependsOn = item.dependsOn.length > 0 ? item.dependsOn.map((issue) => `#${issue}`).join(", ") : "none";
            console.log(
              `[felixai] issue #${item.issueNumber}: parallel_safe=${item.parallelSafe ? "yes" : "no"} overlap=${item.overlapRisk} depends_on=${dependsOn}`
            );
          }
          return;
        }
        case "run": {
          const repoPath = path.resolve(requireValue(getFlagValue(issuesArgs, "--repo"), "Missing --repo value."));
          const repoRoot = await resolveRepoRoot(repoPath);
          await ensureRepoModelPreference(repoRoot);
          const directive =
            getFlagValue(issuesArgs, "--directive") ??
            "Review unfinished GitHub issues, determine the safest dependency-aware order, and start processing them.";
          const runner = new IssueRunner(repoRoot);
          const run = await runner.run({ repoRoot, directive });

          if (hasFlag(issuesArgs, "--json")) {
            console.log(JSON.stringify(run, null, 2));
            return;
          }

          console.log(`[felixai] issue run saved: ${run.runPath ?? "n/a"}`);
          console.log(`[felixai] issue run status: ${run.status}`);
          console.log(`[felixai] issue run summary: ${run.summary}`);
          console.log(`[felixai] issue snapshot: ${run.snapshotPath}`);
          console.log(`[felixai] issue plan: ${run.planPath}`);
          for (const item of run.issues) {
            console.log(
              `[felixai] issue #${item.issueNumber}: status=${item.status} jobs=${item.jobIds.length} depends_on=${
                item.dependsOn.length > 0 ? item.dependsOn.map((issue) => `#${issue}`).join(",") : "none"
              } parallel_safe=${item.parallelSafe ? "yes" : "no"} overlap=${item.overlapRisk}`
            );
          }
          return;
        }
        default:
          throw new Error(`Unknown issues subcommand '${issuesCommand ?? ""}'. Use 'snapshot', 'plan', or 'run'.`);
      }
    }
    case "session": {
      const sessionCommand = rest[0];
      const sessionArgs = rest.slice(1);
      switch (sessionCommand) {
        case "watch":
          await runSessionWatch(sessionArgs);
          return;
        default:
          throw new Error(`Unknown session subcommand '${sessionCommand ?? ""}'. Use 'watch'.`);
      }
    }
    case "version": {
      console.log(`[felixai] version: ${packageJson.version}`);
      console.log("[felixai] config schema version: 1");
      console.log("[felixai] state schema version: 1");
      return;
    }
    case "job": {
      const jobCommand = rest[0];
      const jobArgs = rest.slice(1);
      const manager = await createJobManager();

      switch (jobCommand) {
        case "start": {
          const repoPath = path.resolve(requireValue(getFlagValue(jobArgs, "--repo"), "Missing --repo value."));
          await ensureRepoModelPreference(repoPath);
          const task = await resolveTaskInput(jobArgs);
          const baseBranch = getFlagValue(jobArgs, "--base-branch");
          const parallelism = parseInteger(getFlagValue(jobArgs, "--parallel"));
          const autoResume = hasFlag(jobArgs, "--auto-resume");
          const requireClean = hasFlag(jobArgs, "--require-clean");
          const issueRefs = getMultiFlagValues(jobArgs, "--issue");
          const job = await manager.startJob({
            repoPath,
            task,
            baseBranch,
            parallelism,
            autoResume,
            requireClean,
            issueRefs
          });
          console.log(`[felixai] job ${job.jobId} status: ${job.status}`);
          console.log(`[felixai] planner summary: ${job.planningSummary ?? "n/a"}`);
          const repoInstructionsPath = findRepoInstructionsPath(job);
          if (repoInstructionsPath) {
            console.log(`[felixai] repo instructions: ${repoInstructionsPath}`);
            await printRepoPreferences(job.repoRoot, { includePath: false });
          }
          if (job.issueRefs.length > 0) {
            console.log(`[felixai] issue refs: ${job.issueRefs.join(", ")}`);
          }
          return;
        }
        case "status": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const job = await manager.getJob(jobId);
          if (hasFlag(jobArgs, "--json")) {
            console.log(JSON.stringify(job, null, 2));
            return;
          }

          const summary = summarizeJob(job);
          console.log(`[felixai] job ${job.jobId}`);
          console.log(`[felixai] status: ${job.status}`);
          console.log(`[felixai] repo: ${job.repoRoot}`);
          console.log(`[felixai] base branch: ${job.baseBranch}`);
          if (job.issueRefs.length > 0) {
            console.log(`[felixai] issue refs: ${job.issueRefs.join(", ")}`);
          }
          console.log(`[felixai] planning summary: ${job.planningSummary ?? "n/a"}`);
          const repoInstructionsPath = findRepoInstructionsPath(job);
          if (repoInstructionsPath) {
            console.log(`[felixai] repo instructions: ${repoInstructionsPath}`);
            await printRepoPreferences(job.repoRoot, { includePath: false });
          }
          console.log(
            `[felixai] work items: pending=${summary.pending} running=${summary.running} boundary=${summary.boundary} blocked=${summary.blocked} completed=${summary.completed} failed=${summary.failed}`
          );
          if (job.mergeReadiness.branchReadiness.length > 0) {
            console.log(
              `[felixai] merge readiness: completed=${job.mergeReadiness.completedBranches.length} pending=${job.mergeReadiness.pendingBranches.length}`
            );
            for (const branch of job.mergeReadiness.branchReadiness) {
              const conflicts = branch.conflictWith.length > 0 ? branch.conflictWith.join(",") : "none";
              console.log(
                `[felixai] merge ${branch.workItemId}: branch=${branch.branchName} files=${branch.changedFiles.length} conflicts=${conflicts}`
              );
            }
          }
          if (job.mergeAutomation.attemptedAt) {
            console.log(
              `[felixai] merge automation: status=${job.mergeAutomation.status} target=${job.mergeAutomation.targetBranch} merged=${job.mergeAutomation.mergedBranches.length} pending=${job.mergeAutomation.pendingBranches.length}`
            );
            if (job.mergeAutomation.mergeBranchName) {
              console.log(`[felixai] merge candidate branch: ${job.mergeAutomation.mergeBranchName}`);
            }
          }
          if (job.remoteBranches.length > 0) {
            console.log("[felixai] remote branches:");
            for (const branch of job.remoteBranches) {
              const remoteName = branch.remoteBranchName ?? branch.remoteName ?? "local-only";
              console.log(
                `[felixai] remote ${branch.workItemId}: ${remoteName} status=${branch.pushStatus} ahead=${branch.aheadBy} behind=${branch.behindBy}`
              );
            }
          }
          if (job.pullRequests.length > 0) {
            console.log("[felixai] pull requests:");
            for (const pullRequest of job.pullRequests) {
              console.log(
                `[felixai] pr ${pullRequest.workItemId}: status=${pullRequest.status} source=${pullRequest.sourceBranch} target=${pullRequest.targetBranch}`
              );
              if (pullRequest.error) {
                console.log(`[felixai] pr error: ${pullRequest.error}`);
              }
            }
          }
          if (job.issueSummaries.length > 0) {
            console.log("[felixai] issue summaries:");
            for (const summary of job.issueSummaries) {
              console.log(
                `[felixai] issue ${summary.issueRef}: ${summary.status} items=${summary.workItemIds.join(",")} branches=${summary.branchNames.join(",") || "none"}`
              );
            }
          }
          for (const item of job.workItems) {
            const session = job.sessions.find((entry) => entry.workItemId === item.id);
            const details = [
              `branch=${item.branchName ?? "branch-pending"}`,
              `session=${session?.sessionId ?? item.sessionId ?? "session-pending"}`,
              `attempts=${item.attempts}`
            ];
            if (item.status === "running") {
              const startedAt = parseIsoTimestamp(item.startedAt);
              if (startedAt !== undefined) {
                details.push(`running_for=${formatDuration(Date.now() - startedAt)}`);
              }
              const lastUpdate = parseIsoTimestamp(session?.updatedAt);
              if (lastUpdate !== undefined) {
                const sinceLastUpdate = Date.now() - lastUpdate;
                details.push(`last_signal=${formatDuration(sinceLastUpdate)}_ago`);
                details.push(`signal=${sinceLastUpdate >= 120_000 ? "stale" : "active"}`);
              }
              if (session?.changedFilesCount !== undefined) {
                details.push(`changed_files=${session.changedFilesCount}`);
              }
              if (session?.lastWorkspaceActivityAt) {
                const lastActivity = parseIsoTimestamp(session.lastWorkspaceActivityAt);
                if (lastActivity !== undefined) {
                  details.push(`last_file_update=${formatDuration(Date.now() - lastActivity)}_ago`);
                }
              }
            }
            const issueInfo = item.issueRefs && item.issueRefs.length > 0 ? ` issues=${item.issueRefs.join(",")}` : "";
            const failureInfo = item.failureCategory ? ` failure=${item.failureCategory} retryable=${item.retryable ? "yes" : "no"}` : "";
            console.log(`[felixai] ${item.id}: ${item.status} ${details.join(" ")}${issueInfo}${failureInfo}`);
            if (item.status === "running" && session?.recentChangedFiles && session.recentChangedFiles.length > 0) {
              console.log(`[felixai] ${item.id}: recent_changed=${session.recentChangedFiles.join(", ")}`);
            }
            if (item.status === "running" && session?.progressSummary) {
              console.log(`[felixai] ${item.id}: progress=${session.progressSummary}`);
            }
          }
          const branchDriftItems = job.workItems.filter((item) => item.status === "failed" && isBranchDriftError(item.error));
          if (branchDriftItems.length > 0) {
            console.log("[felixai] action required: branch drift detected");
            for (const item of branchDriftItems) {
              console.log(
                `[felixai] branch drift ${item.id}: expected=${item.branchName ?? "unknown"} workspace=${item.workspacePath ?? "unknown"}`
              );
              console.log(`[felixai] branch drift detail: ${item.error}`);
            }
          }
          const staleRunningItems = job.workItems
            .map((item) => ({
              item,
              session: job.sessions.find((entry) => entry.workItemId === item.id)
            }))
            .filter(({ item, session }) => {
              if (item.status !== "running") {
                return false;
              }
              const updatedAt = parseIsoTimestamp(session?.updatedAt);
              return updatedAt !== undefined && Date.now() - updatedAt >= 120_000;
            });
          if (staleRunningItems.length > 0) {
            console.log("[felixai] action required: running work item may be stalled");
            for (const { item, session } of staleRunningItems) {
              const updatedAt = parseIsoTimestamp(session?.updatedAt) ?? Date.now();
              console.log(
                `[felixai] running ${item.id}: workspace=${item.workspacePath ?? "unknown"} last_signal=${formatDuration(Date.now() - updatedAt)}_ago`
              );
            }
          }
          const recentEvents = job.events.slice(-5);
          if (recentEvents.length > 0) {
            console.log("[felixai] recent events:");
            for (const event of recentEvents) {
              console.log(
                `[felixai] ${event.timestamp} ${event.level} ${event.scope}${event.workItemId ? `:${event.workItemId}` : ""} ${event.message}`
              );
            }
          }
          return;
        }
        case "watch": {
          await runJobWatch(jobArgs);
          return;
        }
        case "resume": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const job = await manager.resumeJob(jobId);
          console.log(`[felixai] job ${job.jobId} status: ${job.status}`);
          return;
        }
        case "push": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const workItemIds = getMultiFlagValues(jobArgs.slice(1), "--work-item");
          const remoteName = getFlagValue(jobArgs.slice(1), "--remote");
          const job = await manager.pushJobBranches(jobId, {
            workItemIds: workItemIds.length > 0 ? workItemIds : undefined,
            remoteName
          });
          console.log(`[felixai] job ${job.jobId} pushed branches refreshed`);
          return;
        }
        case "merge": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const argsWithoutJobId = jobArgs.slice(1);
          const workItemIds = getMultiFlagValues(argsWithoutJobId, "--work-item");
          const targetBranch = getFlagValue(argsWithoutJobId, "--target-branch");
          const job = await manager.mergeJobBranches(jobId, {
            workItemIds: workItemIds.length > 0 ? workItemIds : undefined,
            targetBranch
          });
          if (hasFlag(argsWithoutJobId, "--json")) {
            console.log(JSON.stringify(job.mergeAutomation, null, 2));
            return;
          }
          console.log(`[felixai] merge status: ${job.mergeAutomation.status}`);
          console.log(`[felixai] merge target: ${job.mergeAutomation.targetBranch}`);
          if (job.mergeAutomation.mergeBranchName) {
            console.log(`[felixai] merge branch: ${job.mergeAutomation.mergeBranchName}`);
          }
          console.log(`[felixai] merged branches: ${job.mergeAutomation.mergedBranches.join(", ") || "none"}`);
          if (job.mergeAutomation.conflicts.length > 0) {
            for (const conflict of job.mergeAutomation.conflicts) {
              console.log(`[felixai] conflict ${conflict.sourceBranch}: ${conflict.files.join(", ") || "files unknown"}`);
            }
          }
          if (job.mergeAutomation.error) {
            console.log(`[felixai] merge error: ${job.mergeAutomation.error}`);
          }
          return;
        }
        case "pr": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const argsWithoutJobId = jobArgs.slice(1);
          const workItemIds = getMultiFlagValues(argsWithoutJobId, "--work-item");
          const baseBranch = getFlagValue(argsWithoutJobId, "--base-branch");
          const draft = !hasFlag(argsWithoutJobId, "--no-draft");
          const job = await manager.createJobPullRequests(jobId, {
            workItemIds: workItemIds.length > 0 ? workItemIds : undefined,
            baseBranch,
            draft
          });
          if (hasFlag(argsWithoutJobId, "--json")) {
            console.log(JSON.stringify(job.pullRequests, null, 2));
            return;
          }
          for (const pullRequest of job.pullRequests) {
            console.log(
              `[felixai] pr ${pullRequest.workItemId}: status=${pullRequest.status} source=${pullRequest.sourceBranch} target=${pullRequest.targetBranch}`
            );
            if (pullRequest.error) {
              console.log(`[felixai] pr error: ${pullRequest.error}`);
            }
            if (pullRequest.pullRequestUrl) {
              console.log(`[felixai] pr url: ${pullRequest.pullRequestUrl}`);
            } else if (pullRequest.compareUrl) {
              console.log(`[felixai] compare url: ${pullRequest.compareUrl}`);
            }
          }
          return;
        }
        case "resolve-conflicts": {
          const jobId = requireValue(jobArgs[0], "Missing job id.");
          const argsWithoutJobId = jobArgs.slice(1);
          const sessionId = getFlagValue(argsWithoutJobId, "--session");
          const job = await manager.resolveJobMergeConflicts(jobId, { sessionId });
          if (hasFlag(argsWithoutJobId, "--json")) {
            console.log(JSON.stringify(job.mergeAutomation, null, 2));
            return;
          }
          console.log(`[felixai] conflict resolution status: ${job.mergeAutomation.status}`);
          if (job.mergeAutomation.resolutionSessionId) {
            console.log(`[felixai] resolution session: ${job.mergeAutomation.resolutionSessionId}`);
          }
          if (job.mergeAutomation.resolutionSummary) {
            console.log(`[felixai] resolution summary: ${job.mergeAutomation.resolutionSummary}`);
          }
          if (job.mergeAutomation.conflicts.length > 0) {
            for (const conflict of job.mergeAutomation.conflicts) {
              console.log(`[felixai] remaining conflict ${conflict.sourceBranch}: ${conflict.files.join(", ") || "files unknown"}`);
            }
          }
          return;
        }
        case "list": {
          const jobs = await manager.listJobs();
          if (hasFlag(jobArgs, "--json")) {
            console.log(JSON.stringify(jobs, null, 2));
            return;
          }
          for (const [index, job] of jobs.entries()) {
            if (index > 0) {
              console.log("");
            }
            console.log(formatJobListBlock(job, manager.formatJobListSummary(job)));
          }
          return;
        }
        default:
          throw new Error(
            `Unknown job subcommand '${jobCommand ?? ""}'. Use 'start', 'status', 'watch', 'resume', 'push', 'merge', 'pr', 'resolve-conflicts', or 'list'.`
          );
      }
    }
    default:
      printUsage();
      throw new Error(`Unknown command '${command}'.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    await startFelixShell();
    return;
  }

  if (args[0] === "shell") {
    await startFelixShell();
    return;
  }

  await handleArgs(args);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[felixai] ${message}`);
    process.exit(1);
  });

async function resolveTaskInput(args: string[]): Promise<string> {
  const inlineTask = getFlagValue(args, "--task");
  const taskFile = getFlagValue(args, "--task-file");

  if (inlineTask && taskFile) {
    throw new Error("Use either --task or --task-file, not both.");
  }

  if (inlineTask) {
    return requireValue(inlineTask, "Missing --task value.");
  }

  if (taskFile) {
    const raw = await readJsonFile<unknown>(path.resolve(taskFile));
    return readTaskFromJson(raw);
  }

  throw new Error("Missing task input. Provide --task or --task-file.");
}
