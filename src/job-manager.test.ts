import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPlanningPrompt } from "./codex-adapter.js";
import { runCodexCliIssueSession } from "./codex-cli-exec.js";
import { DEFAULT_CONFIG, ensureFelixDirectories, loadConfig } from "./config.js";
import {
  findCodexModelEntry,
  isUnsupportedCodexModelError,
  loadCodexModelCatalog,
  loadCurrentCodexModel,
  normalizeCodexModelSlug
} from "./codex-models.js";
import { findCodexSessionTranscript, formatTranscriptLine, readTranscriptTail } from "./codex-sessions.js";
import { analyzeGitHubAuthStatus } from "./doctor.js";
import { pathExists, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { normalizeGitHubIssues, parseGitHubIssueExecutionMetadata, snapshotUnfinishedGitHubIssues } from "./github-issues.js";
import { commitAllChanges, getBranchPushStatus } from "./git.js";
import {
  buildPullRequestFailureMessage,
  createPullRequestWithRunner,
  hasGitHubTokenPrecedenceConflict,
  truncateGitHubLabelDescription
} from "./github.js";
import {
  classifyTopLevelInput,
  looksLikeIssueDrivenDirective,
  looksLikeIssueLabelingDirective,
  looksLikePlanThenExecuteDirective,
  parseIssueDirectiveScope
} from "./issue-directives.js";
import { buildIssueLabelingPrompt, validateIssueLabelingResult } from "./issue-labeler.js";
import { buildIssuePlanningPrompt, validateIssuePlanningResult, type GitHubIssueSnapshotItem } from "./issue-planner.js";
import { IssueRunner, selectIssueWave } from "./issue-runner.js";
import { initializeProject } from "./init.js";
import { saveCurrentShellSession } from "./issue-state.js";
import { createJobManager, JobManager } from "./job-manager.js";
import { runCommand } from "./process-utils.js";
import { loadRepoAgentsPreferences, parseRepoAgentsPreferences, saveRepoAgentsPreferences } from "./repo-agents.js";
import { StateStore } from "./state-store.js";
import { refinePlanResult } from "./validation.js";
import { WorkspaceManager } from "./workspace-manager.js";
import type { ExecutionResult, FelixConfig, JobState, PlanResult, WorkspaceAssignment } from "./types.js";

async function createFakeWorkspace(root: string, jobId: string, workItemId: string): Promise<WorkspaceAssignment> {
  const workspacePath = path.join(root, ".felixai", "workspaces", jobId, workItemId);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, "README.md"), `# ${workItemId}\n`, "utf8");
  return {
    workspacePath,
    branchName: `agent/${workItemId}/job-${jobId.slice(0, 8)}`
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function createFakeWorkspaceForIssues(
  root: string,
  jobId: string,
  workItemId: string,
  issueRefs: string[] = []
): Promise<WorkspaceAssignment> {
  const workspace = await createFakeWorkspace(root, jobId, workItemId);
  const issueToken = issueRefs[0] ? `issue-${issueRefs[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : workItemId;
  return {
    ...workspace,
    branchName: `agent/${issueToken}/job-${jobId.slice(0, 8)}-${workItemId}`
  };
}

async function testInit(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-init-"));
  const result = await initializeProject({ projectRoot: root });
  assert.ok(result.created.some((entry) => entry.endsWith(path.join(".felixai", "config.json"))));
  assert.ok(await pathExists(path.join(root, ".felixai", "state", "jobs")));
  assert.ok(await pathExists(path.join(root, ".felixai", "workspaces")));
}

async function testDefaultReasoningEffortIsMedium(): Promise<void> {
  assert.equal(DEFAULT_CONFIG.codex.modelReasoningEffort, "medium");
}

async function testCodexCliIssueSessionStopsPromptlyAfterTaskComplete(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "felix-codex-exec-stop-"));
  const fakeBin = path.join(root, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCodexCmd = path.join(fakeBin, "codex.cmd");
  await writeFile(
    fakeCodexCmd,
    [
      "@echo off",
      "echo {\"type\":\"thread.started\",\"thread_id\":\"fake-thread\"}",
      "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"status\\\":\\\"completed\\\",\\\"summary\\\":\\\"ok\\\",\\\"nextPrompt\\\":null}\"}}",
      "echo {\"type\":\"task_complete\"}",
      "powershell -NoProfile -Command \"Start-Sleep -Seconds 5\""
    ].join("\r\n"),
    "utf8"
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin};${originalPath ?? ""}`;
  try {
    const startedAt = Date.now();
    const result = await runCodexCliIssueSession({
      prompt: "test prompt",
      workspacePath: root
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, "completed");
    assert.equal(result.summary, "ok");
    assert.ok(elapsedMs < 4_000, `expected early worker shutdown, but elapsed ${elapsedMs}ms`);
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}

async function testCodexModelCatalogLoadsDynamicEntriesAndCurrentModel(): Promise<void> {
  const originalUserProfile = process.env.USERPROFILE;
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-codex-catalog-"));
  const codexHome = path.join(root, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "models_cache.json"),
    JSON.stringify(
      {
        models: [
          {
            slug: "gpt-5.4",
            display_name: "gpt-5.4",
            description: "Latest frontier agentic coding model.",
            default_reasoning_level: "medium",
            priority: 1,
            visibility: "list"
          },
          {
            slug: "gpt-5.4-mini",
            display_name: "gpt-5.4-mini",
            default_reasoning_level: "medium",
            priority: 2,
            visibility: "list"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n', "utf8");

  process.env.USERPROFILE = root;
  try {
    const catalog = await loadCodexModelCatalog();
    assert.equal(catalog[0]?.slug, "gpt-5.4");
    assert.equal(catalog[1]?.slug, "gpt-5.4-mini");
    assert.equal(await loadCurrentCodexModel(), "gpt-5.4");
    assert.equal(findCodexModelEntry(catalog, "GPT-5.4")?.slug, "gpt-5.4");
    assert.equal(normalizeCodexModelSlug(" GPT-5.4 "), "gpt-5.4");
  } finally {
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function testUnsupportedCodexModelErrorDetection(): Promise<void> {
  assert.equal(
    isUnsupportedCodexModelError(
      "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'GPT-5.4' model is not supported when using Codex with a ChatGPT account.\"}}"
    ),
    true
  );
  assert.equal(isUnsupportedCodexModelError("network timeout"), false);
}

async function testRunCommandResolvesWindowsCmdShims(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "felix-cmd-shim-"));
  const shimPath = path.join(root, "felix-shim.cmd");
  await writeFile(shimPath, "@echo off\r\necho shim-ok %1\r\n", "utf8");

  const env = {
    ...process.env,
    PATH: `${root};${process.env.PATH ?? ""}`
  };

  const result = await runCommand("felix-shim", ["value"], { env });
  assert.match(result.stdout, /shim-ok value/i);
}

async function testInvalidConfigFailsValidation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-config-"));
  await ensureFelixDirectories(root);
  await writeJsonFile(path.join(root, ".felixai", "config.json"), {
    schemaVersion: 1,
    stateDir: ".felixai/state",
    workspaceRoot: ".felixai/workspaces",
    logDir: ".felixai/logs",
    credentialSource: "not-valid",
    codex: DEFAULT_CONFIG.codex
  });

  await assert.rejects(loadConfig(root), /credentialSource/);
}

async function testLegacyCredentialModesMigrateToCodex(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-config-migrate-"));
  await ensureFelixDirectories(root);

  await writeJsonFile(path.join(root, ".felixai", "config.json"), {
    schemaVersion: 1,
    stateDir: ".felixai/state",
    workspaceRoot: ".felixai/workspaces",
    logDir: ".felixai/logs",
    credentialSource: "chatgpt-session",
    git: DEFAULT_CONFIG.git,
    codex: DEFAULT_CONFIG.codex
  });

  const migratedChatSession = await loadConfig(root);
  assert.equal(migratedChatSession.credentialSource, "codex");

  await writeJsonFile(path.join(root, ".felixai", "config.json"), {
    schemaVersion: 1,
    stateDir: ".felixai/state",
    workspaceRoot: ".felixai/workspaces",
    logDir: ".felixai/logs",
    credentialSource: "env-api-key",
    git: DEFAULT_CONFIG.git,
    codex: DEFAULT_CONFIG.codex
  });

  const migratedApiKey = await loadConfig(root);
  assert.equal(migratedApiKey.credentialSource, "codex");
}

async function testPlanningPromptDiscouragesVerificationOnlyWorkItems(): Promise<void> {
  const prompt = buildPlanningPrompt("Update README only", "main");
  assert.match(prompt, /Do not create separate verification-only, review-only, or diff-check-only work items/i);
  assert.match(prompt, /Avoid no-op work items that would leave their branch with no changes relative to the base branch/i);
  assert.match(prompt, /Only create a separate verification work item when it produces a durable artifact/i);
}

async function testIssuePlanningPromptAndValidation(): Promise<void> {
  const issues: GitHubIssueSnapshotItem[] = [
    {
      number: 12,
      title: "Add retry handling",
      body: "Implement retry handling in the service layer.",
      labels: ["backend"],
      assignees: [],
      state: "OPEN",
      updatedAt: "2026-04-09T00:00:00Z",
      url: "https://github.com/example/repo/issues/12"
    },
    {
      number: 18,
      title: "Add retry tests",
      body: "Cover retry handling with tests.",
      labels: ["tests"],
      assignees: [],
      state: "OPEN",
      updatedAt: "2026-04-09T00:00:00Z",
      url: "https://github.com/example/repo/issues/18"
    }
  ];

  const prompt = buildIssuePlanningPrompt({
    directive: "Review unfinished GitHub issues and figure out the best order to complete them.",
    repoRoot: "C:\\repo",
    issues
  });

  assert.match(prompt, /GitHub issue planning session for FelixAI Orchestrator/i);
  assert.match(prompt, /parallelSafe=true only when the issue can likely run in parallel/i);
  assert.match(prompt, /#?12|Add retry handling/);

  const validated = validateIssuePlanningResult(
    {
      summary: "Implement retry handling before tests.",
      orderedIssues: [
        {
          issueNumber: 12,
          title: "Add retry handling",
          dependsOn: [],
          parallelSafe: false,
          overlapRisk: "medium",
          reasoning: "Touches core service behavior."
        },
        {
          issueNumber: 18,
          title: "Add retry tests",
          dependsOn: [12],
          parallelSafe: false,
          overlapRisk: "high",
          reasoning: "Depends on the implementation work landing first."
        }
      ]
    },
    issues
  );

  assert.equal(validated.orderedIssues.length, 2);
  await assert.rejects(
    Promise.resolve().then(() =>
      validateIssuePlanningResult(
        {
          summary: "Broken",
          orderedIssues: [
            {
              issueNumber: 12,
              title: "Add retry handling",
              dependsOn: [],
              parallelSafe: true,
              overlapRisk: "low",
              reasoning: "ok"
            }
          ]
        },
        issues
      )
    ),
    /omitted issues/i
  );
}

async function testIssueLabelingPromptAndValidation(): Promise<void> {
  const issues: GitHubIssueSnapshotItem[] = [
    {
      number: 44,
      title: "Finalize launch docs",
      body: "Close docs gaps for launch readiness.",
      labels: [],
      assignees: [],
      state: "OPEN",
      updatedAt: "2026-04-09T00:00:00Z",
      url: "https://github.com/example/repo/issues/44"
    },
    {
      number: 45,
      title: "Harden worker reliability",
      body: "Improve worker restart and retry behavior.",
      labels: [],
      assignees: [],
      state: "OPEN",
      updatedAt: "2026-04-09T00:00:00Z",
      url: "https://github.com/example/repo/issues/45"
    }
  ];

  const prompt = buildIssueLabelingPrompt({
    directive: "Review the GitHub issues, label app readiness versus infrastructure readiness, and report back.",
    repoRoot: "C:\\repo",
    issues
  });
  assert.match(prompt, /GitHub issue labeling session for FelixAI Orchestrator/i);
  assert.match(prompt, /Return a compact label set and an assignment entry for every issue/i);

  const validated = validateIssueLabelingResult(
    {
      summary: "Applied readiness labels.",
      labels: [
        {
          name: "app-readiness",
          description: "Tracks application feature and launch-readiness work.",
          color: "1d76db"
        },
        {
          name: "infrastructure-readiness",
          description: "Tracks platform and hosting readiness work.",
          color: "d97706"
        }
      ],
      assignments: [
        {
          issueNumber: 44,
          title: "Finalize launch docs",
          labels: ["app-readiness"],
          reasoning: "Direct launch-facing product readiness work."
        },
        {
          issueNumber: 45,
          title: "Harden worker reliability",
          labels: ["infrastructure-readiness"],
          reasoning: "Worker reliability is infrastructure-oriented."
        }
      ]
    },
    issues
  );
  assert.equal(validated.assignments.length, 2);

  await assert.rejects(
    Promise.resolve().then(() =>
      validateIssueLabelingResult(
        {
          summary: "Broken",
          labels: [
            {
              name: "App Readiness",
              description: "bad",
              color: "1d76db"
            }
          ],
          assignments: [
            {
              issueNumber: 44,
              title: "Finalize launch docs",
              labels: ["App Readiness"],
              reasoning: "bad"
            }
          ]
        },
        issues
      )
    ),
    /invalid label name/i
  );

  await assert.rejects(
    Promise.resolve().then(() =>
      validateIssueLabelingResult(
        {
          summary: "Broken",
          labels: [
            {
              name: "app-readiness",
              description:
                "This description is intentionally made too long for GitHub label validation so Felix rejects it before any write happens.",
              color: "1d76db"
            }
          ],
          assignments: [
            {
              issueNumber: 44,
              title: "Finalize launch docs",
              labels: ["app-readiness"],
              reasoning: "bad"
            },
            {
              issueNumber: 45,
              title: "Harden worker reliability",
              labels: [],
              reasoning: "bad"
            }
          ]
        },
        issues
      )
    ),
    /longer than 100 characters/i
  );

  assert.equal(
    truncateGitHubLabelDescription(
      "This description is intentionally made too long for GitHub label validation so Felix trims it before creating the label."
    ).length,
    100
  );
}

async function testNormalizeGitHubIssuesAndSnapshotPersistence(): Promise<void> {
  const normalized = normalizeGitHubIssues([
    {
      id: "I_123",
      number: 7,
      title: " Add docs command ",
      body: "First paragraph.\n\nSecond paragraph.",
      state: "OPEN",
      updatedAt: "2026-04-09T00:00:00Z",
      url: "https://github.com/example/repo/issues/7",
      labels: [{ name: "docs" }],
      assignees: [{ login: "pat" }]
    }
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.bodySummary, "First paragraph.");
  assert.deepEqual(normalized[0]?.labels, ["docs"]);
  assert.deepEqual(normalized[0]?.assignees, ["pat"]);

  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-snapshot-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  const { snapshot, outputPath } = await snapshotUnfinishedGitHubIssues(root, root, {
    fetchIssues: async () => normalized
  });
  assert.equal(snapshot.issues.length, 1);
  assert.ok(await pathExists(outputPath));
}

async function testGitHubIssueMetadataParserAcceptsTrailingDoneCriteriaBullets(): Promise<void> {
  const metadata = parseGitHubIssueExecutionMetadata(
    [
      "## Summary",
      "Body",
      "",
      "## Execution Metadata",
      "- Lane: ordered",
      "- Depends on: none",
      "- Parallel-safe: no",
      "",
      "## Done Criteria",
      "- implementation is complete",
      "- validation passed"
    ].join("\n"),
    ["app-ready"]
  );

  assert.deepEqual(metadata.validationErrors, []);
  assert.equal(metadata.doneChecklistCount, 2);
  assert.equal(metadata.doneChecklistCompletedCount, 0);
}

async function testIssueWaveSelectionPrefersParallelSafeLowOverlapIssues(): Promise<void> {
  const wave = selectIssueWave([
    {
      issueNumber: 38,
      title: "Scheduler",
      lane: "ready-parallel",
      phase: "implementation",
      dependsOn: [],
      parallelSafe: true,
      overlapRisk: "low",
      reasoning: "Independent scheduling change.",
      status: "pending",
      jobIds: [],
      updatedAt: nowIso()
    },
    {
      issueNumber: 39,
      title: "CLI intake",
      lane: "ready-parallel",
      phase: "implementation",
      dependsOn: [],
      parallelSafe: true,
      overlapRisk: "low",
      reasoning: "CLI-only change.",
      status: "pending",
      jobIds: [],
      updatedAt: nowIso()
    },
    {
      issueNumber: 41,
      title: "Issue repetition",
      lane: "ordered",
      phase: "implementation",
      dependsOn: [38],
      parallelSafe: false,
      overlapRisk: "high",
      reasoning: "Depends on scheduler state.",
      status: "pending",
      jobIds: [],
      updatedAt: nowIso()
    }
  ]);

  assert.deepEqual(
    wave.map((issue) => issue.issueNumber),
    [38, 39]
  );
}

async function testIssueRunnerPersistsRunStateAndStopsOnBlockedIssue(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-runner-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await ensureFelixDirectories(root);

  const managerFactory = (async () =>
    ({
      startJob: async ({ issueRefs }: { issueRefs?: string[] }) =>
        ({
          schemaVersion: 1,
          jobId: `job-${issueRefs?.[0] ?? "none"}`,
          status: issueRefs?.[0] === "101" ? "completed" : "paused",
          repoPath: root,
          repoRoot: root,
          task: "task",
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: true,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "WI-1",
              title: "work",
              prompt: "work",
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: issueRefs?.[0] === "101" ? "completed" : "blocked",
              attempts: 1,
              lastResponse: issueRefs?.[0] === "101" ? "done" : "need operator input",
              error: issueRefs?.[0] === "101" ? undefined : "need operator input",
              retryable: true
            }
          ],
          sessions: [],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        }) satisfies JobState
    })) as unknown as typeof createJobManager;

  const runner = new IssueRunner(
    root,
    managerFactory,
    {
      snapshotter: async () => ({
        snapshot: {
          repoRoot: root,
          generatedAt: nowIso(),
          issues: [
            {
              id: "I_101",
              number: 101,
              title: "Independent issue",
              body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ready-parallel\n- Depends on: none\n- Parallel-safe: yes\n\n## Done Criteria\n- [ ] done",
              bodySummary: "Body",
              labels: [],
              assignees: [],
              state: "OPEN",
              updatedAt: nowIso(),
              url: "https://example.test/issues/101",
              executionMetadata: {
                lane: "ready-parallel",
                dependsOn: [],
                parallelSafe: true,
                doneChecklistCount: 1,
                doneChecklistCompletedCount: 0,
                validationErrors: []
              }
            },
            {
              id: "I_102",
              number: 102,
              title: "Blocked issue",
              body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ready-parallel\n- Depends on: none\n- Parallel-safe: yes\n\n## Done Criteria\n- [ ] done",
              bodySummary: "Body",
              labels: [],
              assignees: [],
              state: "OPEN",
              updatedAt: nowIso(),
              url: "https://example.test/issues/102",
              executionMetadata: {
                lane: "ready-parallel",
                dependsOn: [],
                parallelSafe: true,
                doneChecklistCount: 1,
                doneChecklistCompletedCount: 0,
                validationErrors: []
              }
            }
          ]
        },
        outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
      }),
      fetchIssue: async (_repoRoot, issueNumber) => ({
        id: `I_${issueNumber}`,
        number: issueNumber,
        title: issueNumber === 101 ? "Independent issue" : "Blocked issue",
        body: "## Done Criteria\n- [x] done",
        bodySummary: "done",
        labels: [],
        assignees: [],
        state: issueNumber === 101 ? "CLOSED" : "OPEN",
        updatedAt: nowIso(),
        url: `https://example.test/issues/${issueNumber}`,
        executionMetadata: {
          lane: "ordered",
          dependsOn: [],
          parallelSafe: false,
          doneChecklistCount: 1,
          doneChecklistCompletedCount: issueNumber === 101 ? 1 : 0,
          validationErrors: []
        }
        }),
        ensureLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabels: async () => {},
        closeIssue: async () => {}
      }
    );

  const run = await runner.run({
    repoRoot: root,
    directive: "Review unfinished GitHub issues and start processing them."
  });

  assert.equal(run.status, "paused");
  assert.equal(run.issues.find((issue) => issue.issueNumber === 101)?.status, "completed");
  assert.equal(run.issues.find((issue) => issue.issueNumber === 102)?.status, "blocked");
  assert.ok(await pathExists(path.join(root, ".felixai", "state", "issues")));
}

async function testIssueRunnerDoesNotRetryBlockedJobs(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-runner-blocked-once-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await ensureFelixDirectories(root);

  let startCount = 0;
  const managerFactory = (async () =>
    ({
      startJob: async ({ issueRefs }: { issueRefs?: string[] }) => {
        startCount += 1;
        return {
          schemaVersion: 1,
          jobId: `job-${startCount}`,
          status: "paused",
          repoPath: root,
          repoRoot: root,
          task: "task",
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: true,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "WI-1",
              title: "blocked work",
              prompt: "blocked work",
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: "blocked",
              attempts: 1,
              lastResponse: "need operator input",
              error: "need operator input",
              retryable: false,
              manualReviewRequired: true
            }
          ],
          sessions: [],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        } satisfies JobState;
      }
    })) as unknown as typeof createJobManager;

  const runner = new IssueRunner(root, managerFactory, {
    snapshotter: async () => ({
      snapshot: {
        repoRoot: root,
        generatedAt: nowIso(),
        issues: [
            {
              id: "I_109",
              number: 109,
              title: "Blocked issue",
              body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- [ ] done",
              bodySummary: "Body",
              labels: ["app-ready"],
              assignees: [],
              state: "OPEN",
              updatedAt: nowIso(),
              url: "https://example.test/issues/109",
              executionMetadata: {
                lane: "ordered",
                dependsOn: [],
                parallelSafe: false,
                doneChecklistCount: 1,
                doneChecklistCompletedCount: 0,
                validationErrors: []
              }
            }
          ]
        },
        outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
      }),
      fetchIssue: async () => ({
        id: "I_109",
        number: 109,
        title: "Blocked issue",
        body: "## Done Criteria\n- [ ] done",
        bodySummary: "Body",
        labels: ["app-ready"],
        assignees: [],
        state: "OPEN",
        updatedAt: nowIso(),
        url: "https://example.test/issues/109",
        executionMetadata: {
          lane: "ordered",
          dependsOn: [],
          parallelSafe: false,
          doneChecklistCount: 1,
          doneChecklistCompletedCount: 0,
          validationErrors: []
        }
      }),
        ensureLabel: async () => {},
        addIssueLabels: async () => {},
        removeIssueLabels: async () => {},
        closeIssue: async () => {}
    });

  const run = await runner.run({
    repoRoot: root,
    directive: "implement github issue #109"
  });

  assert.equal(startCount, 3);
  assert.equal(run.status, "paused");
  assert.equal(run.issues[0]?.status, "blocked");
}

async function testCodexSessionTranscriptDiscoveryAndFormatting(): Promise<void> {
  const originalUserProfile = process.env.USERPROFILE;
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-codex-session-"));
  const sessionId = "019d76f8-17ba-7ba3-bb0c-46a7fbe09bb8";
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "04", "10");
  await mkdir(sessionDir, { recursive: true });
  const transcriptPath = path.join(sessionDir, `rollout-2026-04-10T05-37-43-${sessionId}.jsonl`);
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        timestamp: "2026-04-10T10:37:46.343Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: "C:\\repo"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-10T10:39:18.048Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-10T10:39:18.298Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "Exit code: 0\r\nWall time: 0.2 seconds\r\nOutput:\r\nok\r\n"
        }
      })
    ].join("\n"),
    "utf8"
  );

  process.env.USERPROFILE = root;
  try {
    assert.equal(await findCodexSessionTranscript(sessionId), transcriptPath);
    const tail = await readTranscriptTail(transcriptPath, 2);
    assert.equal(tail.length, 2);
    assert.match(formatTranscriptLine(tail[0]!), /tool call shell_command/);
    assert.match(formatTranscriptLine(tail[1]!), /tool output exit=0/);
  } finally {
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function testTranscriptFormatterHandlesDirectResponseItemsAndSuppressesRawNoise(): Promise<void> {
  const colonPrefixedReasoning = ':{"type":"reasoning","summary":[],"content":null,"encrypted_content":"secret"}';
  const directToolOutput = JSON.stringify({
    type: "function_call_output",
    output: "Exit code: 0\r\nWall time: 0.9 seconds\r\nOutput:\r\nsrc\\\\SettingsPage.razor:15:            <select class=\\\"field\\\">\r\nsrc\\\\Other.cs:10: ok\r\n"
  });
  const directToolCall = JSON.stringify({
    timestamp: "2026-04-11T19:35:13.435Z",
    type: "function_call",
    name: "shell_command"
  });

  assert.equal(formatTranscriptLine(colonPrefixedReasoning), "[unknown-time] reasoning");
  assert.equal(formatTranscriptLine(directToolCall), "[2026-04-11T19:35:13.435Z] tool call shell_command");
  assert.match(
    formatTranscriptLine(directToolOutput),
    /\[unknown-time\] tool output exit=0 src\\\\SettingsPage\.razor:15:/
  );
  assert.doesNotMatch(formatTranscriptLine(colonPrefixedReasoning), /encrypted_content|secret/);
}

async function testIssueRunnerFiltersToExplicitIssuesAndStopsAfterFirstRequestedImplementation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-scope-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await ensureFelixDirectories(root);

  const managerFactory = (async () =>
    ({
      startJob: async ({ issueRefs }: { issueRefs?: string[] }) =>
        ({
          schemaVersion: 1,
          jobId: `job-${issueRefs?.[0] ?? "none"}`,
          status: "completed",
          repoPath: root,
          repoRoot: root,
          task: "task",
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: true,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "WI-1",
              title: "work",
              prompt: "work",
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: "completed",
              attempts: 1,
              lastResponse: "done"
            }
          ],
          sessions: [],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        }) satisfies JobState
    })) as unknown as typeof createJobManager;

  const runner = new IssueRunner(root, managerFactory, {
    snapshotter: async () => ({
      snapshot: {
        repoRoot: root,
        generatedAt: nowIso(),
        issues: [
            {
              id: "I_138",
              number: 138,
              title: "Workflow issue",
              body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: blocked\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- [ ] done",
              bodySummary: "Body",
              labels: ["workflow", "blocked"],
              assignees: [],
              state: "OPEN",
              updatedAt: nowIso(),
              url: "https://example.test/issues/138",
              executionMetadata: {
                lane: "blocked",
                dependsOn: [],
                parallelSafe: false,
                doneChecklistCount: 1,
                doneChecklistCompletedCount: 0,
                validationErrors: []
              }
            },
            {
              id: "I_144",
              number: 144,
              title: "App issue",
              body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- [ ] done",
              bodySummary: "Body",
              labels: ["app-ready"],
              assignees: [],
              state: "OPEN",
              updatedAt: nowIso(),
              url: "https://example.test/issues/144",
              executionMetadata: {
                lane: "ordered",
                dependsOn: [],
                parallelSafe: false,
                doneChecklistCount: 1,
                doneChecklistCompletedCount: 0,
                validationErrors: []
              }
            },
            {
              id: "I_200",
              number: 200,
              title: "Other issue",
              body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- [ ] done",
              bodySummary: "Body",
              labels: ["app-ready"],
              assignees: [],
              state: "OPEN",
              updatedAt: nowIso(),
              url: "https://example.test/issues/200",
              executionMetadata: {
                lane: "ordered",
                dependsOn: [],
                parallelSafe: false,
                doneChecklistCount: 1,
                doneChecklistCompletedCount: 0,
                validationErrors: []
              }
            }
          ]
        },
        outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
      }),
      fetchIssue: async (_repoRoot, issueNumber) => ({
        id: `I_${issueNumber}`,
        number: issueNumber,
        title: issueNumber === 144 ? "App issue" : issueNumber === 138 ? "Workflow issue" : "Other issue",
        body: issueNumber === 144 ? "## Done Criteria\n- [x] done" : "## Done Criteria\n- [ ] done",
        bodySummary: "Body",
        labels: issueNumber === 144 ? ["app-ready"] : issueNumber === 138 ? ["workflow", "blocked"] : ["app-ready"],
        assignees: [],
        state: issueNumber === 144 ? "CLOSED" : "OPEN",
        updatedAt: nowIso(),
        url: `https://example.test/issues/${issueNumber}`,
        executionMetadata: {
          lane: issueNumber === 138 ? "blocked" : "ordered",
          dependsOn: [],
          parallelSafe: false,
          doneChecklistCount: 1,
          doneChecklistCompletedCount: issueNumber === 144 ? 1 : 0,
          validationErrors: []
        }
      }),
      ensureLabel: async () => {},
      addIssueLabels: async () => {},
      removeIssueLabels: async () => {},
      closeIssue: async () => {}
    });

  const run = await runner.run({
    repoRoot: root,
    directive: "review github issues #138 and #144, decide which should go first, then implement the first one"
  });

  assert.equal(run.status, "completed");
  assert.equal(run.issues.length, 2);
  assert.equal(run.issues.find((issue) => issue.issueNumber === 144)?.status, "completed");
  assert.equal(run.issues.find((issue) => issue.issueNumber === 138)?.status, "pending");
  assert.match(run.summary, /First matching issue implemented/i);
}

async function testIssueRunnerTransitionsFromImplementationToValidationPhase(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-phase-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await runCommand("git", ["config", "user.email", "felix@example.test"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Felix Tests"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await writeFile(path.join(root, "phase.txt"), "base\n", "utf8");
  await runCommand("git", ["add", "AGENTS.md", "phase.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: root });
  const sourceBranch = "agent/issue-109/job-phase-issue-attempt";
  await runCommand("git", ["checkout", "-b", sourceBranch], { cwd: root });
  await writeFile(path.join(root, "phase.txt"), "validation branch\n", "utf8");
  await runCommand("git", ["add", "phase.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "phase work"], { cwd: root });
  await runCommand("git", ["checkout", "main"], { cwd: root });
  await ensureFelixDirectories(root);

  const tasks: string[] = [];
  const initialSessionIds: Array<string | undefined> = [];
  const managerFactory = (async () =>
    ({
      startJob: async ({ task, issueRefs, initialSessionId }: { task: string; issueRefs?: string[]; initialSessionId?: string }) => {
        tasks.push(task);
        initialSessionIds.push(initialSessionId);
        return {
          schemaVersion: 1,
          jobId: `job-${tasks.length}`,
          status: "completed",
          repoPath: root,
          repoRoot: root,
          task,
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: false,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "issue-attempt",
              title: "phase work",
              prompt: task,
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: "completed",
              attempts: 1,
              branchName: sourceBranch,
              sessionId: tasks.length === 1 ? "session-109" : initialSessionId,
              lastResponse: "done"
            }
          ],
          sessions: [
            {
              workItemId: "issue-attempt",
              sessionId: tasks.length === 1 ? "session-109" : initialSessionId,
              status: "completed",
              attemptCount: 1,
              branchName: sourceBranch,
              updatedAt: nowIso()
            }
          ],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        } satisfies JobState;
      }
    })) as unknown as typeof createJobManager;

  let fetchCount = 0;
  const runner = new IssueRunner(root, managerFactory, {
    snapshotter: async () => ({
      snapshot: {
        repoRoot: root,
        generatedAt: nowIso(),
        issues: [
          {
            id: "I_109",
            number: 109,
            title: "Two phase issue",
            body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- [ ] done",
            bodySummary: "Body",
            labels: ["app-ready"],
            assignees: [],
            state: "OPEN",
            updatedAt: nowIso(),
            url: "https://example.test/issues/109",
            executionMetadata: {
              lane: "ordered",
              dependsOn: [],
              parallelSafe: false,
              doneChecklistCount: 1,
              doneChecklistCompletedCount: 0,
              validationErrors: []
            }
          }
        ]
      },
      outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
    }),
    fetchIssue: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          id: "I_109",
          number: 109,
          title: "Two phase issue",
          body: "## Done Criteria\n- [ ] done",
          bodySummary: "Body",
          labels: ["app-ready", "ready-to-test"],
          assignees: [],
          state: "OPEN",
          updatedAt: nowIso(),
          url: "https://example.test/issues/109",
          executionMetadata: {
            lane: "ordered",
            dependsOn: [],
            parallelSafe: false,
            doneChecklistCount: 1,
            doneChecklistCompletedCount: 0,
            validationErrors: []
          }
        };
      }

      return {
        id: "I_109",
        number: 109,
        title: "Two phase issue",
        body: "## Done Criteria\n- [ ] done",
        bodySummary: "Body",
        labels: ["app-ready", "done"],
        assignees: [],
        state: "OPEN",
        updatedAt: nowIso(),
        url: "https://example.test/issues/109",
        executionMetadata: {
          lane: "ordered",
          dependsOn: [],
          parallelSafe: false,
          doneChecklistCount: 1,
          doneChecklistCompletedCount: 0,
          validationErrors: []
        }
      };
    },
      ensureLabel: async () => {},
      addIssueLabels: async () => {},
      removeIssueLabels: async () => {},
      closeIssue: async () => {}
    });

  const run = await runner.run({
    repoRoot: root,
    directive: "implement github issue #109"
  });

  assert.equal(run.status, "completed");
  assert.equal(tasks.length, 2);
  assert.equal(initialSessionIds[0], undefined);
  assert.equal(initialSessionIds[1], "session-109");
  assert.match(tasks[0]!, /Execution phase: implementation/);
  assert.match(tasks[0]!, /Read the shared repo context first:/);
  assert.match(tasks[0]!, /Consult AGENTS\.md only if the shared repo context is missing something important\./);
  assert.match(tasks[0]!, /add the GitHub label `ready-to-test`/);
  assert.match(tasks[1]!, /Execution phase: validation/);
  assert.match(tasks[1]!, /Read the validation handoff first:/);
  assert.match(tasks[1]!, /add the `done` label, and close or move the issue to done/i);
  assert.equal(
    await pathExists(path.join(root, ".felixai", "state", "issues", `${path.basename(root)}-issue-109-validation-handoff.md`)),
    true
  );
}

async function testIssueRunnerReusesSameSessionForValidationWhenJobAutoResumed(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-reuse-validation-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await runCommand("git", ["config", "user.email", "felix@example.test"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Felix Tests"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await writeFile(path.join(root, "src.txt"), "base\n", "utf8");
  await runCommand("git", ["add", "AGENTS.md", "src.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: root });

  const sourceBranch = "agent/issue-310/job-current-issue-attempt";
  await runCommand("git", ["checkout", "-b", sourceBranch], { cwd: root });
  await writeFile(path.join(root, "src.txt"), "validated in same session\n", "utf8");
  await runCommand("git", ["add", "src.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "issue implementation"], { cwd: root });
  await runCommand("git", ["checkout", "main"], { cwd: root });

  const addLabelCalls: Array<{ issueNumber: number; labels: string[] }> = [];
  const removeLabelCalls: Array<{ issueNumber: number; labels: string[] }> = [];
  const closeCalls: Array<{ issueNumber: number; comment?: string }> = [];

  const managerFactory = (async () =>
    ({
      startJob: async ({ task, issueRefs }: { task: string; issueRefs?: string[] }) =>
        ({
          schemaVersion: 1,
          jobId: "job-reused-session",
          status: "completed",
          repoPath: root,
          repoRoot: root,
          task,
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: true,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "issue-attempt",
              title: "phase work",
              prompt: task,
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: "completed",
              attempts: 2,
              branchName: sourceBranch,
              lastResponse: "validated in reused session"
            }
          ],
          sessions: [
            {
              workItemId: "issue-attempt",
              sessionId: "session-310",
              status: "completed",
              attemptCount: 2,
              branchName: sourceBranch,
              updatedAt: nowIso()
            }
          ],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        }) satisfies JobState
    })) as unknown as typeof createJobManager;

  const runner = new IssueRunner(root, managerFactory, {
    snapshotter: async () => ({
      snapshot: {
        repoRoot: root,
        generatedAt: nowIso(),
        issues: [
          {
            id: "I_310",
            number: 310,
            title: "Reuse validation session",
            body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- done",
            bodySummary: "Body",
            labels: ["app-ready"],
            assignees: [],
            state: "OPEN",
            updatedAt: nowIso(),
            url: "https://example.test/issues/310",
            executionMetadata: {
              lane: "ordered",
              dependsOn: [],
              parallelSafe: false,
              doneChecklistCount: 1,
              doneChecklistCompletedCount: 0,
              validationErrors: []
            }
          }
        ]
      },
      outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
    }),
    fetchIssue: async () => ({
      id: "I_310",
      number: 310,
      title: "Reuse validation session",
      body: "## Done Criteria\n- done",
      bodySummary: "Body",
      labels: ["ready-to-test", "done"],
      assignees: [],
      state: "CLOSED",
      updatedAt: nowIso(),
      url: "https://example.test/issues/310",
      executionMetadata: {
        lane: "ordered",
        dependsOn: [],
        parallelSafe: false,
        doneChecklistCount: 1,
        doneChecklistCompletedCount: 1,
        validationErrors: []
      }
    }),
    ensureLabel: async () => {},
    addIssueLabels: async (options) => {
      addLabelCalls.push({ issueNumber: options.issueNumber, labels: options.labels });
    },
    removeIssueLabels: async (options) => {
      removeLabelCalls.push({ issueNumber: options.issueNumber, labels: options.labels });
    },
    closeIssue: async (options) => {
      closeCalls.push({ issueNumber: options.issueNumber, comment: options.comment });
    }
  });

  const run = await runner.run({
    repoRoot: root,
    directive: "implement github issue #310"
  });

  assert.equal(run.status, "completed");
  assert.equal(run.issues[0]?.status, "completed");
  assert.deepEqual(removeLabelCalls, [{ issueNumber: 310, labels: ["ready-to-test"] }]);
  assert.deepEqual(addLabelCalls, [{ issueNumber: 310, labels: ["done"] }]);
  assert.equal(closeCalls.length, 1);
  assert.equal((await readFile(path.join(root, "src.txt"), "utf8")).trim(), "validated in same session");
}

async function testIssueRunnerReusesSameSessionWhenImplementationNeedsAnotherTurn(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-reuse-impl-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await ensureFelixDirectories(root);

  const initialSessionIds: Array<string | undefined> = [];
  let startCount = 0;
  const managerFactory = (async () =>
    ({
      startJob: async ({ task, issueRefs, initialSessionId }: { task: string; issueRefs?: string[]; initialSessionId?: string }) => {
        startCount += 1;
        initialSessionIds.push(initialSessionId);
        return {
          schemaVersion: 1,
          jobId: `job-${startCount}`,
          status: "completed",
          repoPath: root,
          repoRoot: root,
          task,
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: true,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "issue-attempt",
              title: "impl work",
              prompt: task,
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: "completed",
              attempts: 1,
              sessionId: startCount === 1 ? "session-410" : initialSessionId,
              lastResponse: "implementation continued"
            }
          ],
          sessions: [
            {
              workItemId: "issue-attempt",
              sessionId: startCount === 1 ? "session-410" : initialSessionId,
              status: "completed",
              attemptCount: 1,
              updatedAt: nowIso()
            }
          ],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        } satisfies JobState;
      }
    })) as unknown as typeof createJobManager;

  let fetchCount = 0;
  const runner = new IssueRunner(root, managerFactory, {
    snapshotter: async () => ({
      snapshot: {
        repoRoot: root,
        generatedAt: nowIso(),
        issues: [
          {
            id: "I_410",
            number: 410,
            title: "Continue implementation",
            body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- done",
            bodySummary: "Body",
            labels: ["app-ready"],
            assignees: [],
            state: "OPEN",
            updatedAt: nowIso(),
            url: "https://example.test/issues/410",
            executionMetadata: {
              lane: "ordered",
              dependsOn: [],
              parallelSafe: false,
              doneChecklistCount: 1,
              doneChecklistCompletedCount: 0,
              validationErrors: []
            }
          }
        ]
      },
      outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
    }),
    fetchIssue: async () => {
      fetchCount += 1;
      return {
        id: "I_410",
        number: 410,
        title: "Continue implementation",
        body: "## Done Criteria\n- done",
        bodySummary: "Body",
        labels: fetchCount === 1 ? ["app-ready"] : ["done"],
        assignees: [],
        state: fetchCount === 1 ? "OPEN" : "CLOSED",
        updatedAt: nowIso(),
        url: "https://example.test/issues/410",
        executionMetadata: {
          lane: "ordered",
          dependsOn: [],
          parallelSafe: false,
          doneChecklistCount: 1,
          doneChecklistCompletedCount: fetchCount === 1 ? 0 : 1,
          validationErrors: []
        }
      };
    },
    ensureLabel: async () => {},
    addIssueLabels: async () => {},
    removeIssueLabels: async () => {},
    closeIssue: async () => {}
  });

  const run = await runner.run({
    repoRoot: root,
    directive: "implement github issue #410"
  });

  assert.equal(run.status, "completed");
  assert.equal(startCount, 2);
  assert.equal(initialSessionIds[0], undefined);
  assert.equal(initialSessionIds[1], "session-410");
}

async function testIssueRunnerValidationFinalizesBranchAndArchivesSupersededJobs(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-finalize-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await runCommand("git", ["config", "user.email", "felix@example.test"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Felix Tests"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await writeFile(path.join(root, "src.txt"), "base\n", "utf8");
  await runCommand("git", ["add", "AGENTS.md", "src.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: root });

  const sourceBranch = "agent/issue-109/job-current-issue-attempt";
  await runCommand("git", ["checkout", "-b", sourceBranch], { cwd: root });
  await writeFile(path.join(root, "src.txt"), "validated change\n", "utf8");
  await runCommand("git", ["add", "src.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "issue implementation"], { cwd: root });
  await runCommand("git", ["checkout", "main"], { cwd: root });

  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  await store.saveJob({
    schemaVersion: 1,
    jobId: "old-running",
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "old running",
    issueRefs: ["109"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  await store.saveJob({
    schemaVersion: 1,
    jobId: "old-failed",
    status: "failed",
    repoPath: root,
    repoRoot: root,
    task: "old failed",
    issueRefs: ["109"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  const addLabelCalls: Array<{ issueNumber: number; labels: string[] }> = [];
  const removeLabelCalls: Array<{ issueNumber: number; labels: string[] }> = [];
  const closeCalls: Array<{ issueNumber: number; comment?: string }> = [];

  const managerFactory = (async () =>
    ({
      startJob: async ({ task, issueRefs }: { task: string; issueRefs?: string[] }) =>
        ({
          schemaVersion: 1,
          jobId: "job-current",
          status: "completed",
          repoPath: root,
          repoRoot: root,
          task,
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: false,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "issue-attempt",
              title: "validation work",
              prompt: task,
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: "completed",
              attempts: 1,
              branchName: sourceBranch,
              lastResponse: "validated"
            }
          ],
          sessions: [],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        }) satisfies JobState
    })) as unknown as typeof createJobManager;

  const runner = new IssueRunner(root, managerFactory, {
    snapshotter: async () => ({
      snapshot: {
        repoRoot: root,
        generatedAt: nowIso(),
        issues: [
          {
            id: "I_109",
            number: 109,
            title: "Finalize validated issue",
            body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- done",
            bodySummary: "Body",
            labels: ["ready-to-test"],
            assignees: [],
            state: "OPEN",
            updatedAt: nowIso(),
            url: "https://example.test/issues/109",
            executionMetadata: {
              lane: "ordered",
              dependsOn: [],
              parallelSafe: false,
              doneChecklistCount: 1,
              doneChecklistCompletedCount: 0,
              validationErrors: []
            }
          }
        ]
      },
      outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
    }),
    fetchIssue: async () => ({
      id: "I_109",
      number: 109,
      title: "Finalize validated issue",
      body: "## Done Criteria\n- done",
      bodySummary: "Body",
      labels: ["done"],
      assignees: [],
      state: "CLOSED",
      updatedAt: nowIso(),
      url: "https://example.test/issues/109",
      executionMetadata: {
        lane: "ordered",
        dependsOn: [],
        parallelSafe: false,
        doneChecklistCount: 1,
        doneChecklistCompletedCount: 1,
        validationErrors: []
      }
    }),
    ensureLabel: async () => {},
    addIssueLabels: async (options) => {
      addLabelCalls.push({ issueNumber: options.issueNumber, labels: options.labels });
    },
    removeIssueLabels: async (options) => {
      removeLabelCalls.push({ issueNumber: options.issueNumber, labels: options.labels });
    },
    closeIssue: async (options) => {
      closeCalls.push({ issueNumber: options.issueNumber, comment: options.comment });
    }
  });

  const run = await runner.run({
    repoRoot: root,
    directive: "implement github issue #109"
  });

  assert.equal(run.status, "completed");
  assert.equal(run.issues[0]?.status, "completed");
  assert.deepEqual(removeLabelCalls, [{ issueNumber: 109, labels: ["ready-to-test"] }]);
  assert.deepEqual(addLabelCalls, [{ issueNumber: 109, labels: ["done"] }]);
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0]?.issueNumber, 109);
  assert.equal((await readFile(path.join(root, "src.txt"), "utf8")).trim(), "validated change");
  assert.equal(await pathExists(path.join(root, ".felixai", "state", "archive", "jobs", "old-running.json")), true);
  assert.equal(await pathExists(path.join(root, ".felixai", "state", "archive", "jobs", "old-failed.json")), true);
}

async function testIssueRunnerArchivesOlderCompletedJobsButKeepsCurrentJob(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issue-archive-current-"));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });
  await runCommand("git", ["config", "user.email", "felix@example.test"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Felix Tests"], { cwd: root });
  await writeFile(path.join(root, "AGENTS.md"), "model: gpt-5.4\n", "utf8");
  await writeFile(path.join(root, "src.txt"), "base\n", "utf8");
  await runCommand("git", ["add", "AGENTS.md", "src.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: root });

  const sourceBranch = "agent/issue-210/job-current-issue-attempt";
  await runCommand("git", ["checkout", "-b", sourceBranch], { cwd: root });
  await writeFile(path.join(root, "src.txt"), "validated change\n", "utf8");
  await runCommand("git", ["add", "src.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "issue implementation"], { cwd: root });
  await runCommand("git", ["checkout", "main"], { cwd: root });

  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  await store.saveJob({
    schemaVersion: 1,
    jobId: "old-completed",
    status: "completed",
    repoPath: root,
    repoRoot: root,
    task: "old completed",
    issueRefs: ["210"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  const managerFactory = (async () =>
    ({
      startJob: async ({ task, issueRefs }: { task: string; issueRefs?: string[] }) =>
        ({
          schemaVersion: 1,
          jobId: "job-current",
          status: "completed",
          repoPath: root,
          repoRoot: root,
          task,
          issueRefs: issueRefs ?? [],
          baseBranch: "main",
          parallelism: 1,
          autoResume: false,
          maxResumesPerItem: 2,
          planningSummary: "summary",
          workItems: [
            {
              id: "issue-attempt",
              title: "validation work",
              prompt: task,
              issueRefs: issueRefs ?? [],
              dependsOn: [],
              status: "completed",
              attempts: 1,
              branchName: sourceBranch,
              lastResponse: "validated"
            }
          ],
          sessions: [],
          events: [],
          mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
          mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
          remoteBranches: [],
          pullRequests: [],
          issueSummaries: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        }) satisfies JobState
    })) as unknown as typeof createJobManager;

  const runner = new IssueRunner(root, managerFactory, {
    snapshotter: async () => ({
      snapshot: {
        repoRoot: root,
        generatedAt: nowIso(),
        issues: [
          {
            id: "I_210",
            number: 210,
            title: "Archive older jobs safely",
            body: "## Summary\nBody\n\n## Execution Metadata\n- Lane: ordered\n- Depends on: none\n- Parallel-safe: no\n\n## Done Criteria\n- done",
            bodySummary: "Body",
            labels: ["ready-to-test"],
            assignees: [],
            state: "OPEN",
            updatedAt: nowIso(),
            url: "https://example.test/issues/210",
            executionMetadata: {
              lane: "ordered",
              dependsOn: [],
              parallelSafe: false,
              doneChecklistCount: 1,
              doneChecklistCompletedCount: 0,
              validationErrors: []
            }
          }
        ]
      },
      outputPath: path.join(root, ".felixai", "state", "issues", "snapshot.json")
    }),
    fetchIssue: async () => ({
      id: "I_210",
      number: 210,
      title: "Archive older jobs safely",
      body: "## Done Criteria\n- done",
      bodySummary: "Body",
      labels: ["done"],
      assignees: [],
      state: "CLOSED",
      updatedAt: nowIso(),
      url: "https://example.test/issues/210",
      executionMetadata: {
        lane: "ordered",
        dependsOn: [],
        parallelSafe: false,
        doneChecklistCount: 1,
        doneChecklistCompletedCount: 1,
        validationErrors: []
      }
    }),
    ensureLabel: async () => {},
    addIssueLabels: async () => {},
    removeIssueLabels: async () => {},
    closeIssue: async () => {}
  });

  await runner.run({
    repoRoot: root,
    directive: "implement github issue #210"
  });

  assert.equal(await pathExists(path.join(root, ".felixai", "state", "archive", "jobs", "old-completed.json")), true);
}

async function testStateStoreLoadsArchivedJobs(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-state-archived-load-"));
  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const job: JobState = {
    schemaVersion: 1,
    jobId: "archived-job",
    status: "completed",
    repoPath: root,
    repoRoot: root,
    task: "archived task",
    issueRefs: ["99"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await store.saveJob(job);
  assert.equal(await store.archiveJob(job.jobId), true);

  const loaded = await store.loadJob(job.jobId);
  assert.equal(loaded.jobId, "archived-job");
  assert.equal(loaded.status, "completed");
}

async function testLooksLikeIssueDrivenDirectiveDetectsGitHubIssuePrompt(): Promise<void> {
  assert.equal(
    looksLikeIssueDrivenDirective(
      "review",
      ["all", "github", "issues", "that", "are", "not", "done", "and", "start", "processing", "them"]
    ),
    true
  );
  assert.equal(looksLikeIssueDrivenDirective("review", ["all", "github", "issues", "and", "plan", "the", "best", "order"]), false);
  assert.equal(looksLikeIssueDrivenDirective("process", ["the", "open", "github", "issues", "in", "dependency", "order"]), true);
  assert.equal(
    looksLikeIssueDrivenDirective(
      "figure",
      ["out", "the", "best", "order", "to", "complete", "unfinished", "issues", "and", "then", "process", "them"]
    ),
    true
  );
  assert.equal(looksLikeIssueDrivenDirective("version", []), false);
}

async function testLooksLikePlanThenExecuteDirectiveDetectsMixedIntent(): Promise<void> {
  assert.equal(
    looksLikePlanThenExecuteDirective(
      "review",
      ["github", "issues", "#138", "and", "#144,", "decide", "which", "should", "go", "first,", "then", "implement", "the", "first", "one"]
    ),
    true
  );
  assert.equal(
    looksLikePlanThenExecuteDirective("implement", ["github", "issue", "#144"]),
    false
  );
}

async function testLooksLikeIssueLabelingDirectiveDetectsLabelWork(): Promise<void> {
  assert.equal(
    looksLikeIssueLabelingDirective(
      "i",
      ["want", "you", "to", "review", "the", "github", "issues", "and", "add", "labels", "for", "app", "readiness"]
    ),
    true
  );
  assert.equal(looksLikeIssueLabelingDirective("how", ["many", "issues", "are", "not", "done"]), false);
  assert.equal(
    looksLikeIssueLabelingDirective(
      "review",
      ["github", "issues", "and", "prioritize", "all", "issues", "with", "app-ready", "label", "then", "proceed", "with", "implementing", "them"]
    ),
    false
  );
}

async function testClassifyTopLevelInputRoutesKnownCommandsIssuesAndRepoPrompts(): Promise<void> {
  assert.equal(classifyTopLevelInput("version", []), "command");
  assert.equal(classifyTopLevelInput("review", ["all", "github", "issues"]), "repo");
  assert.equal(
    classifyTopLevelInput(
      "review",
      ["all", "github", "issues", "that", "are", "not", "done", "and", "start", "processing", "them"]
    ),
    "issue"
  );
  assert.equal(
    classifyTopLevelInput(
      "i",
      [
        "want",
        "you",
        "to",
        "review",
        "the",
        "github",
        "issues",
        "and",
        "figure",
        "out",
        "which",
        "issues",
        "are",
        "for",
        "app",
        "features",
        "and",
        "which",
        "are",
        "infrastructure"
      ]
    ),
    "repo"
  );
  assert.equal(
    classifyTopLevelInput(
      "i",
      ["want", "you", "to", "review", "the", "github", "issues", "and", "add", "labels", "for", "app", "readiness"]
    ),
    "issue_labels"
  );
  assert.equal(
    classifyTopLevelInput("implement", ["all", "the", "github", "issues", "with", "the", "label", "app-ready"]),
    "issue"
  );
  assert.equal(
    classifyTopLevelInput(
      "review",
      ["github", "issues", "and", "prioritize", "all", "issues", "with", "app-ready", "label", "then", "proceed", "with", "implementing", "them"]
    ),
    "issue"
  );
  assert.equal(classifyTopLevelInput("how", ["many", "issues", "are", "not", "done"]), "repo");
  assert.equal(classifyTopLevelInput("tell", ["me", "about", "this", "repo"]), "repo");
}

async function testParseIssueDirectiveScopeExtractsIssueRefsLabelsAndFirstOnly(): Promise<void> {
  const parsed = parseIssueDirectiveScope("review", [
    "github",
    "issues",
    "#138",
    "and",
    "#144,",
    "decide",
    "which",
    "should",
    "go",
    "first,",
    "then",
    "implement",
    "the",
    "first",
    "one",
    "with",
    "label",
    "app-ready"
  ]);

  assert.deepEqual(parsed.issueNumbers, [138, 144]);
  assert.deepEqual(parsed.labelFilters, ["app-ready"]);
  assert.equal(parsed.implementFirstOnly, true);
}

async function testPlanRefinementCollapsesCoupledTestWorkItems(): Promise<void> {
  const refined = refinePlanResult({
    summary: "Split implementation and tests",
    workItems: [
      {
        id: "WI-1",
        title: "Trim input in formatGreeting while preserving default behavior",
        prompt: "Update src/index.js to trim surrounding whitespace before formatting the greeting.",
        dependsOn: []
      },
      {
        id: "WI-2",
        title: "Add trimming coverage and keep npm test passing",
        prompt: "Update test/index.test.js to cover trimming behavior and run npm test.",
        dependsOn: ["WI-1"]
      }
    ]
  });

  assert.equal(refined.workItems.length, 1);
  assert.equal(refined.workItems[0]?.id, "WI-1");
  assert.match(refined.workItems[0]?.title ?? "", /Add trimming coverage/i);
  assert.match(refined.workItems[0]?.prompt ?? "", /test\/index\.test\.js/i);
  assert.match(refined.summary, /collapsed 1 coupled verification item/i);
}

async function testPlanRefinementKeepsIndependentWorkItemsSplit(): Promise<void> {
  const refined = refinePlanResult({
    summary: "Two independent items",
    workItems: [
      {
        id: "WI-1",
        title: "Implement API endpoint",
        prompt: "Update src/api.ts to add the new endpoint.",
        dependsOn: []
      },
      {
        id: "WI-2",
        title: "Add dashboard widget",
        prompt: "Update src/dashboard.tsx for the new widget.",
        dependsOn: []
      }
    ]
  });

  assert.equal(refined.workItems.length, 2);
  assert.equal(refined.summary, "Two independent items");
}

async function testPlannerAndExecutionFlow(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-job-"));
  await ensureFelixDirectories(root);

  const config: FelixConfig = {
    ...DEFAULT_CONFIG,
    workspaceRoot: ".felixai/workspaces",
    stateDir: ".felixai/state",
    logDir: ".felixai/logs",
    codex: {
      ...DEFAULT_CONFIG.codex,
      autoResume: false,
      parallelism: 2
    }
  };

  const store = new StateStore(root, { stateDir: config.stateDir, logDir: config.logDir });
  const manager = new JobManager({
    config,
    store,
    resolveRepoContext: async (repoPath, requestedBaseBranch) => ({
      repoRoot: repoPath,
      baseBranch: requestedBaseBranch ?? "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Two independent items",
      workItems: [
        { id: "plan-api", title: "Plan API", prompt: "Do api work", dependsOn: [] },
        { id: "plan-ui", title: "Plan UI", prompt: "Do ui work", dependsOn: [] }
      ]
    }),
    executor: async ({ prompt, workspacePath }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} at ${workspacePath}`,
      sessionId: `session-${path.basename(workspacePath)}`
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "Build the next milestone"
  });

  assert.equal(job.status, "completed");
  assert.equal(job.workItems.filter((item) => item.status === "completed").length, 2);
  assert.ok(job.workItems.every((item) => item.branchName?.startsWith("agent/")));
  assert.ok(await pathExists(job.workItems[0].workspacePath as string));
  assert.ok(await pathExists(path.join(root, ".felixai", "state", "plans", `${job.jobId}.plan.json`)));
  assert.ok(await pathExists(path.join(root, ".felixai", "logs", "jobs", `${job.jobId}.events.jsonl`)));
  assert.ok(await pathExists(path.join(root, ".felixai", "logs", "jobs", `${job.jobId}.summary.json`)));
}

async function testStartJobLoadsRepoAgentsInstructionsAndPassesThemToPlannerAndExecutor(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-agents-"));
  await ensureFelixDirectories(root);
  await writeFile(
    path.join(root, "AGENTS.md"),
    ["model: gpt-5.4", "reasoning_effort: high", "", "Use snake_case helpers and keep tests updated."].join("\n"),
    "utf8"
  );

  let plannerInstructions: string | undefined;
  let executorInstructions: string | undefined;
  let plannerPreferences: { model?: string; modelReasoningEffort?: string } | undefined;
  let executorPreferences: { model?: string; modelReasoningEffort?: string } | undefined;
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    resolveRepoContext: async (repoPath, requestedBaseBranch) => ({
      repoRoot: repoPath,
      baseBranch: requestedBaseBranch ?? "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (task, _repoRoot, _baseBranch, runtimePreferences): Promise<PlanResult> => {
      plannerInstructions = task;
      plannerPreferences = runtimePreferences;
      return {
        summary: "Single item",
        workItems: [{ id: "WI-1", title: "Apply change", prompt: "Do the work", dependsOn: [] }]
      };
    },
    executor: async ({ prompt, model, modelReasoningEffort }): Promise<ExecutionResult> => {
      executorInstructions = prompt;
      executorPreferences = { model, modelReasoningEffort };
      return {
        status: "completed",
        summary: "done",
        sessionId: "session-agents"
      };
    }
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "Apply change"
  });

  assert.match(plannerInstructions ?? "", /Repository instructions file: .*AGENTS\.md/);
  assert.match(plannerInstructions ?? "", /Read and follow that file during this planning session/i);
  assert.match(plannerInstructions ?? "", /Task: Apply change/);
  assert.deepEqual(plannerPreferences, { model: "gpt-5.4", modelReasoningEffort: "high" });
  assert.match(executorInstructions ?? "", /Repository instructions file: .*AGENTS\.md/);
  assert.match(executorInstructions ?? "", /Read and follow that file during this work item/i);
  assert.match(executorInstructions ?? "", /Dedicated branch for this work item:/);
  assert.match(executorInstructions ?? "", /Do the work/);
  assert.deepEqual(executorPreferences, { model: "gpt-5.4", modelReasoningEffort: "high" });
  assert.equal(job.events.some((event) => /Loaded repository instructions/.test(event.message)), true);
}

async function testRepoAgentsPreferencesPersistModelAndReasoning(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-agents-prefs-"));
  const saved = await saveRepoAgentsPreferences(root, {
    model: "gpt-5.4",
    reasoningEffort: "high"
  });

  assert.equal(saved.model, "gpt-5.4");
  assert.equal(saved.reasoningEffort, "high");

  const loaded = await loadRepoAgentsPreferences(root);
  assert.equal(loaded?.model, "gpt-5.4");
  assert.equal(loaded?.reasoningEffort, "high");

  await saveRepoAgentsPreferences(root, {
    model: "gpt-5.4-mini",
    reasoningEffort: "medium"
  });

  const updated = await loadRepoAgentsPreferences(root);
  assert.equal(updated?.model, "gpt-5.4-mini");
  assert.equal(updated?.reasoningEffort, "medium");
  assert.match(updated?.content ?? "", /^model: gpt-5\.4-mini/im);
  assert.match(updated?.content ?? "", /^reasoning_effort: medium/im);
}

async function testRepoAgentsPreferencesParseExecutionPolicy(): Promise<void> {
  const parsed = parseRepoAgentsPreferences(
    ["model: gpt-5.4", "reasoning_effort: high", "turbo_mode: enabled", "encourage_subagents: true"].join("\n"),
    "AGENTS.md"
  );

  assert.equal(parsed?.model, "gpt-5.4");
  assert.equal(parsed?.reasoningEffort, "high");
  assert.equal(parsed?.turboMode, true);
  assert.equal(parsed?.encourageSubagents, true);
}

async function testCliConfigSetPersistsRepoModelAndReasoning(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-cli-config-"));
  await ensureFelixDirectories(root);
  await writeJsonFile(path.join(root, ".felixai", "config.json"), structuredClone(DEFAULT_CONFIG));
  await runCommand("git", ["init", "-b", "main"], { cwd: root });

  await runCommand(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "config", "set", "reasoning-effort", "high"], {
    cwd: root
  });
  const config = await loadConfig(root);
  assert.equal(config.codex.modelReasoningEffort, "high");

  await runCommand(
    process.execPath,
    [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "config", "set", "model", "gpt-5.1-codex-max", "--repo", root],
    {
      cwd: root
    }
  );
  const repoPreferences = await loadRepoAgentsPreferences(root);
  assert.equal(repoPreferences?.model, "gpt-5.1-codex-max");

  await runCommand(
    process.execPath,
    [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "config", "set", "reasoning-effort", "xhigh", "--repo", root],
    {
      cwd: root
    }
  );
  const updatedRepoPreferences = await loadRepoAgentsPreferences(root);
  assert.equal(updatedRepoPreferences?.reasoningEffort, "xhigh");
}

async function testResumeFlow(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-resume-"));
  await ensureFelixDirectories(root);

  let firstAttempt = true;
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    resolveRepoContext: async (repoPath, requestedBaseBranch) => ({
      repoRoot: repoPath,
      baseBranch: requestedBaseBranch ?? "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Single item",
      workItems: [{ id: "resume-item", title: "Resume item", prompt: "Keep going", dependsOn: [] }]
    }),
    executor: async ({ sessionId }): Promise<ExecutionResult> => {
      if (firstAttempt) {
        firstAttempt = false;
        return {
          status: "needs_resume",
          summary: "Boundary reached",
          nextPrompt: "Continue the implementation",
          sessionId: sessionId ?? "resume-session"
        };
      }

      return {
        status: "completed",
        summary: "Finished after resume",
        sessionId: sessionId ?? "resume-session"
      };
    }
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "Do resume-sensitive work"
  });
  assert.equal(started.status, "paused");

  const resumed = await manager.resumeJob(started.jobId);
  assert.equal(resumed.status, "completed");

  const saved = await readJsonFile<JobState>(path.join(root, ".felixai", "state", "jobs", `${started.jobId}.json`));
  assert.equal(saved.status, "completed");
}

async function testLongRunningExecutionPersistsHeartbeatWarning(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-heartbeat-"));
  await ensureFelixDirectories(root);

  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    executionHeartbeatMs: 20,
    staleRunningWarningMs: 40,
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Single long-running item",
      workItems: [{ id: "slow", title: "Slow item", prompt: "Slow item", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        status: "completed",
        summary: "finished",
        sessionId: "slow-session"
      };
    }
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "exercise heartbeat"
  });

  assert.equal(job.status, "completed");
  assert.equal(job.events.some((event) => /Execution still running after/i.test(event.message)), true);
}

async function testInvalidStateFailsValidation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-state-"));
  await ensureFelixDirectories(root);
  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", "broken.json"), {
    schemaVersion: 1,
    jobId: "broken",
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "broken",
    baseBranch: "main",
    parallelism: 0,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: {
      completedBranches: [],
      pendingBranches: [],
      branchReadiness: []
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    issueSummaries: [],
    issueRefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  await assert.rejects(store.loadJob("broken"), /parallelism/);
}

async function testRequireCleanRejectsDirtyRepo(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-clean-"));
  await ensureFelixDirectories(root);

  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: true
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Should never plan",
      workItems: [{ id: "x", title: "x", prompt: "x", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "dirty repo allowed by override path"
  });
  assert.equal(job.events.some((event) => /uncommitted changes/i.test(event.message)), true);
}

async function testBaseBranchFailureBubblesClearly(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-branch-"));
  await ensureFelixDirectories(root);

  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => {
      throw new Error("Base branch 'missing-branch' does not exist in repository.");
    },
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "Should never plan",
      workItems: [{ id: "x", title: "x", prompt: "x", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(
    manager.startJob({
      repoPath: root,
      task: "bad branch"
    }),
    /missing-branch/
  );
}

async function testDuplicatePlanIdsFail(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-plan-dup-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "duplicate ids",
      workItems: [
        { id: "dup", title: "one", prompt: "one", dependsOn: [] },
        { id: "dup", title: "two", prompt: "two", dependsOn: [] }
      ]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(manager.startJob({ repoPath: root, task: "dup ids" }), /duplicate work item id/i);
}

async function testMissingDependencyFails(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-plan-missing-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "missing dep",
      workItems: [{ id: "a", title: "A", prompt: "A", dependsOn: ["missing"] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(manager.startJob({ repoPath: root, task: "missing dep" }), /depends on missing work item/i);
}

async function testCircularDependencyFails(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-plan-cycle-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "cycle",
      workItems: [
        { id: "a", title: "A", prompt: "A", dependsOn: ["b"] },
        { id: "b", title: "B", prompt: "B", dependsOn: ["a"] }
      ]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "ok"
    })
  });

  await assert.rejects(manager.startJob({ repoPath: root, task: "cycle" }), /circular dependency/i);
}

async function testMergeReadinessIsPersisted(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-merge-"));
  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    analyzeMergeReadiness: async (job) => ({
      completedBranches: ["agent/a/job-12345678", "agent/b/job-12345678"],
      pendingBranches: [],
      branchReadiness: [
        {
          workItemId: "a",
          branchName: "agent/a/job-12345678",
          changedFiles: ["src/shared.ts"],
          conflictWith: ["agent/b/job-12345678"]
        },
        {
          workItemId: "b",
          branchName: "agent/b/job-12345678",
          changedFiles: ["src/shared.ts", "src/feature.ts"],
          conflictWith: ["agent/a/job-12345678"]
        }
      ],
      generatedAt: new Date().toISOString()
    }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "merge readiness",
      workItems: [
        { id: "a", title: "A", prompt: "A", dependsOn: [] },
        { id: "b", title: "B", prompt: "B", dependsOn: [] }
      ]
    }),
    executor: async ({ workspacePath }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: workspacePath,
      sessionId: `session-${path.basename(workspacePath)}`
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "merge readiness"
  });

  assert.equal(job.mergeReadiness.branchReadiness.length, 2);
  assert.equal(job.mergeReadiness.branchReadiness[0].conflictWith.length > 0, true);
}

async function testSchedulerStartsDependentWorkWithoutWaitingForWholeWave(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-scheduler-"));
  await ensureFelixDirectories(root);
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();

  const manager = new JobManager({
    config: {
      ...DEFAULT_CONFIG,
      codex: {
        ...DEFAULT_CONFIG.codex,
        parallelism: 2
      }
    },
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "scheduler",
      workItems: [
        { id: "a", title: "A", prompt: "A", dependsOn: [] },
        { id: "b", title: "B", prompt: "B", dependsOn: [] },
        { id: "c", title: "C", prompt: "C", dependsOn: ["a"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> =>
      new Promise((resolve) => {
        started.push(prompt.toLowerCase());
        resolvers.set(prompt.toLowerCase(), () =>
          resolve({
            status: "completed",
            summary: prompt,
            sessionId: `session-${prompt.toLowerCase()}`
          })
        );
      })
  });

  const jobPromise = manager.startJob({
    repoPath: root,
    task: "scheduler"
  });

  while (!(started.includes("a") && started.includes("b"))) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  resolvers.get("a")?.();

  while (!started.includes("c")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(started.includes("c"), true);
  resolvers.get("b")?.();
  resolvers.get("c")?.();
  const job = await jobPromise;
  assert.equal(job.status, "completed");
}

async function testIssueRefsPropagateToJobsAndBranches(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-issues-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "issues",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [] }
      ]
    }),
    executor: async ({ workspacePath }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: workspacePath,
      sessionId: `session-${path.basename(workspacePath)}`
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "issue refs",
    issueRefs: ["999"]
  });

  assert.deepEqual(job.issueRefs, ["999"]);
  assert.deepEqual(job.workItems.find((item) => item.id === "api")?.issueRefs, ["142"]);
  assert.deepEqual(job.workItems.find((item) => item.id === "ui")?.issueRefs, ["999"]);
  assert.match(job.workItems.find((item) => item.id === "api")?.branchName ?? "", /issue-142/);
}

async function testRemoteBranchMetadataAndIssueSummariesPersist(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-remote-"));
  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    analyzeRemoteBranches: async () => [
      {
        workItemId: "api",
        branchName: "agent/issue-142/job-12345678-api",
        issueRefs: ["142"],
        remoteName: "origin",
        remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
        remoteBranchName: "origin/agent/issue-142/job-12345678-api",
        existsRemotely: true,
        pushStatus: "ahead-of-remote",
        aheadBy: 2,
        behindBy: 0,
        checkedAt: new Date().toISOString()
      },
      {
        workItemId: "ui",
        branchName: "agent/issue-999/job-12345678-ui",
        issueRefs: ["999"],
        remoteName: "origin",
        remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
        remoteBranchName: "origin/agent/issue-999/job-12345678-ui",
        existsRemotely: false,
        pushStatus: "branch-not-pushed",
        aheadBy: 0,
        behindBy: 0,
        checkedAt: new Date().toISOString()
      }
    ],
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "remote metadata",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [], issueRefs: ["999"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} complete`,
      sessionId: `session-${prompt.toLowerCase()}`
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "remote metadata"
  });

  assert.equal(job.remoteBranches.length, 2);
  assert.equal(job.remoteBranches.find((branch) => branch.workItemId === "api")?.pushStatus, "ahead-of-remote");
  assert.equal(job.remoteBranches.find((branch) => branch.workItemId === "ui")?.pushStatus, "branch-not-pushed");
  assert.equal(job.issueSummaries.length, 2);
  assert.equal(job.issueSummaries.find((summary) => summary.issueRef === "142")?.status, "completed");
  assert.match(job.issueSummaries.find((summary) => summary.issueRef === "142")?.remoteBranches[0] ?? "", /origin\/agent\/issue-142/);

  const saved = await readJsonFile<JobState>(path.join(root, ".felixai", "state", "jobs", `${job.jobId}.json`));
  assert.equal(saved.remoteBranches.length, 2);
  assert.equal(saved.issueSummaries.length, 2);
}

async function testWorkspaceManagerReusesAndReattachesExistingWorktrees(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-worktree-"));
  const repoRoot = path.join(root, "repo");
  const worktreeState = new Map<string, string>();
  const existingPaths = new Set<string>();
  const managerA = new WorkspaceManager(path.join(root, ".felixai", "workspaces-a"), {
    pathExists: async (target) => existingPaths.has(path.resolve(target)),
    pruneWorktrees: async () => {},
    listWorktrees: async () =>
      [...worktreeState.entries()].map(([branch, worktreePath]) => ({
        path: worktreePath,
        branch,
        bare: false
      })),
    createWorktree: async (_repo, workspacePath, branchName) => {
      existingPaths.add(path.resolve(workspacePath));
      worktreeState.set(branchName, workspacePath);
    }
  });
  const managerB = new WorkspaceManager(path.join(root, ".felixai", "workspaces-b"), {
    pathExists: async (target) => existingPaths.has(path.resolve(target)),
    pruneWorktrees: async () => {},
    listWorktrees: async () =>
      [...worktreeState.entries()].map(([branch, worktreePath]) => ({
        path: worktreePath,
        branch,
        bare: false
      })),
    createWorktree: async (_repo, workspacePath, branchName) => {
      existingPaths.add(path.resolve(workspacePath));
      worktreeState.set(branchName, workspacePath);
    }
  });

  const first = await managerA.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);
  const second = await managerA.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);
  const third = await managerB.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);

  assert.equal(first.mode, "created");
  assert.equal(second.mode, "reused");
  assert.equal(second.workspacePath, first.workspacePath);
  assert.equal(third.mode, "reattached");
  assert.equal(third.workspacePath, first.workspacePath);

  existingPaths.delete(path.resolve(first.workspacePath));
  worktreeState.clear();
  const recreated = await managerA.ensureWorkspace("12345678-job", "api", "main", repoRoot, ["142"]);
  assert.equal(recreated.mode, "created");
}

async function testWorkspaceManagerUsesUniqueBranchNamesPerJob(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-branch-unique-"));
  const repoRoot = path.join(root, "repo");
  const manager = new WorkspaceManager(path.join(root, ".felixai", "workspaces"), {
    pathExists: async () => false,
    pruneWorktrees: async () => {},
    listWorktrees: async () => [],
    createWorktree: async () => {}
  });

  const first = await manager.ensureWorkspace("20260407024625-1e5badd8", "api", "main", repoRoot, []);
  const second = await manager.ensureWorkspace("20260407025121-e0f2e086", "api", "main", repoRoot, []);

  assert.notEqual(first.branchName, second.branchName);
}

async function testWorkspaceConflictIsClassifiedAndPersisted(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-workspace-conflict-"));
  await ensureFelixDirectories(root);
  const conflictPath = path.join(root, ".felixai", "workspaces", "conflict-job", "api");
  await mkdir(conflictPath, { recursive: true });
  await writeFile(path.join(conflictPath, "stale.txt"), "stale", "utf8");

  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async () => {
        throw new Error(`Workspace conflict: path '${conflictPath}' already exists.`);
      }
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "workspace conflict",
      workItems: [{ id: "api", title: "API", prompt: "API", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "should not run"
    })
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "workspace conflict"
  });

  assert.equal(job.status, "failed");
  assert.equal(job.workItems[0].status, "failed");
  assert.equal(job.workItems[0].failureCategory, "workspace-conflict");
  assert.equal(job.workItems[0].retryable, false);
  assert.equal(job.events.some((event) => event.scope === "workspace" && /workspace-conflict/i.test(event.message)), true);
}

async function testBranchDriftFailsWorkItemInsteadOfRecordingWrongBranch(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-branch-drift-"));
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await ensureFelixDirectories(root);

  await runCommand("git", ["init", "--initial-branch=main"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "felix@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Felix Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repo });

  const config: FelixConfig = {
    ...DEFAULT_CONFIG,
    workspaceRoot: ".felixai/workspaces",
    stateDir: ".felixai/state",
    logDir: ".felixai/logs"
  };

  const manager = new JobManager({
    config,
    store: new StateStore(root, { stateDir: config.stateDir, logDir: config.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: repo,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: new WorkspaceManager(path.join(root, ".felixai", "workspaces")),
    planner: async (): Promise<PlanResult> => ({
      summary: "branch drift",
      workItems: [{ id: "api", title: "API", prompt: "Change README", dependsOn: [] }]
    }),
    executor: async ({ workspacePath, branchName }): Promise<ExecutionResult> => {
      assert.ok(branchName);
      await runCommand("git", ["-C", workspacePath, "checkout", "-b", "agent/drifted-branch"]);
      await writeFile(path.join(workspacePath, "README.md"), "# Drifted\n", "utf8");
      return {
        status: "completed",
        summary: "Switched to a different branch",
        sessionId: "session-drift"
      };
    }
  });

  const job = await manager.startJob({
    repoPath: repo,
    task: "branch drift"
  });

  assert.equal(job.status, "failed");
  assert.equal(job.workItems[0]?.status, "failed");
  assert.match(job.workItems[0]?.error ?? "", /branch drift detected/i);
  assert.equal(job.workItems[0]?.failureCategory, "git");
}

async function testBlockedExecutionIsPersistedForManualReview(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-blocked-"));
  await ensureFelixDirectories(root);
  let blockedOnce = true;
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "blocked",
      workItems: [{ id: "review", title: "Review", prompt: "Review", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => {
      if (blockedOnce) {
        blockedOnce = false;
        return {
          status: "blocked",
          summary: "Human approval required"
        };
      }

      return {
        status: "completed",
        summary: "Approved and completed"
      };
    }
  });

  const job = await manager.startJob({
    repoPath: root,
    task: "blocked"
  });

  assert.equal(job.status, "paused");
  assert.equal(job.workItems[0].status, "blocked");
  assert.equal(job.workItems[0].failureCategory, "execution-blocked");
  assert.equal(job.workItems[0].retryable, false);
  assert.equal(job.workItems[0].manualReviewRequired, true);
  assert.equal(job.sessions[0]?.status, "blocked");

  const resumed = await manager.resumeJob(job.jobId);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.workItems[0].status, "completed");
}

async function testPushJobBranchesRefreshesRemoteState(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-push-"));
  await ensureFelixDirectories(root);
  let pushed = false;
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    analyzeRemoteBranches: async () =>
      pushed
        ? [
            {
              workItemId: "api",
              branchName: "agent/issue-142/job-12345678-api",
              issueRefs: ["142"],
              remoteName: "origin",
              remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
              remoteBranchName: "origin/agent/issue-142/job-12345678-api",
              existsRemotely: true,
              pushStatus: "up-to-date",
              aheadBy: 0,
              behindBy: 0,
              checkedAt: new Date().toISOString()
            }
          ]
        : [
            {
              workItemId: "api",
              branchName: "agent/issue-142/job-12345678-api",
              issueRefs: ["142"],
              remoteName: "origin",
              remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
              remoteBranchName: "origin/agent/issue-142/job-12345678-api",
              existsRemotely: false,
              pushStatus: "branch-not-pushed",
              aheadBy: 0,
              behindBy: 0,
              checkedAt: new Date().toISOString()
            }
          ],
    pushWorkItemBranches: async (job) => {
      pushed = true;
      return [
        {
          workItemId: job.workItems[0].id,
          branchName: job.workItems[0].branchName as string,
          issueRefs: job.workItems[0].issueRefs ?? [],
          remoteName: "origin",
          remoteUrl: "https://github.com/PixelatedCaptain/FelixAI.git",
          remoteBranchName: `origin/${job.workItems[0].branchName as string}`,
          existsRemotely: true,
          pushStatus: "up-to-date",
          aheadBy: 0,
          behindBy: 0,
          checkedAt: new Date().toISOString()
        }
      ];
    },
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "push",
      workItems: [{ id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "done",
      sessionId: "session-api"
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "push"
  });
  assert.equal(started.remoteBranches[0]?.pushStatus, "branch-not-pushed");

  const pushedJob = await manager.pushJobBranches(started.jobId);
  assert.equal(pushedJob.remoteBranches[0]?.pushStatus, "up-to-date");
  assert.equal(pushedJob.events.some((event) => /pushed completed branches/i.test(event.message)), true);
}

async function testMergeAutomationPersistsSuccessAndConflict(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-merge-auto-"));
  await ensureFelixDirectories(root);
  let conflictMode = false;
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    runMergeAutomation: async (job) =>
      conflictMode
        ? {
            targetBranch: "main",
            mergeBranchName: `agent/merge/job-${job.jobId.slice(0, 8)}`,
            mergedBranches: [job.workItems[0].branchName as string],
            pendingBranches: [],
            conflicts: [
              {
                sourceBranch: job.workItems[1].branchName as string,
                files: ["src/shared.ts"]
              }
            ],
            status: "conflicted",
            workspacePath: path.join(root, ".felixai", "merges", job.jobId),
            attemptedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            error: "merge conflict"
          }
        : {
            targetBranch: "main",
            mergeBranchName: `agent/merge/job-${job.jobId.slice(0, 8)}`,
            mergedBranches: job.workItems.map((item) => item.branchName as string),
            pendingBranches: [],
            conflicts: [],
            status: "merged",
            workspacePath: path.join(root, ".felixai", "merges", job.jobId),
            attemptedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          },
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "merge auto",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [], issueRefs: ["143"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} done`,
      sessionId: `session-${prompt.toLowerCase()}`
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "merge auto"
  });

  const merged = await manager.mergeJobBranches(started.jobId);
  assert.equal(merged.mergeAutomation.status, "merged");
  assert.equal(merged.mergeAutomation.mergedBranches.length, 2);

  conflictMode = true;
  const conflicted = await manager.mergeJobBranches(started.jobId);
  assert.equal(conflicted.mergeAutomation.status, "conflicted");
  assert.equal(conflicted.mergeAutomation.conflicts.length, 1);
}

async function testCreateJobPullRequestsPersistsLinks(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-pr-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    createPullRequests: async (job) =>
      job.workItems.map((item, index) => ({
        workItemId: item.id,
        sourceBranch: item.branchName as string,
        targetBranch: "main",
        issueRefs: item.issueRefs ?? [],
        title: item.title,
        body: `PR for ${item.id}`,
        compareUrl: `https://github.com/PixelatedCaptain/FelixAI/compare/main...${item.branchName as string}`,
        pullRequestNumber: index + 10,
        pullRequestUrl: `https://github.com/PixelatedCaptain/FelixAI/pull/${index + 10}`,
        status: "draft",
        updatedAt: new Date().toISOString()
      })),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "pr",
      workItems: [{ id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "done",
      sessionId: "session-api"
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "pr"
  });
  const job = await manager.createJobPullRequests(started.jobId);
  assert.equal(job.pullRequests.length, 1);
  assert.equal(job.pullRequests[0]?.status, "draft");
  assert.match(job.pullRequests[0]?.pullRequestUrl ?? "", /\/pull\/10$/);
}

async function testCreateJobPullRequestsPersistsFailureReason(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-pr-failure-"));
  await ensureFelixDirectories(root);
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    createPullRequests: async (job) => [
      {
        workItemId: job.workItems[0].id,
        sourceBranch: job.workItems[0].branchName as string,
        targetBranch: "main",
        issueRefs: [],
        title: job.workItems[0].title,
        body: "PR body",
        compareUrl: `https://github.com/example/repo/compare/main...${job.workItems[0].branchName as string}`,
        error: "GitHub CLI has a valid keyring login, but an invalid GITHUB_TOKEN is taking precedence.",
        status: "not-created",
        updatedAt: new Date().toISOString()
      }
    ],
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "pr failure",
      workItems: [{ id: "api", title: "API", prompt: "API", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "done",
      sessionId: "session-api"
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "pr failure"
  });
  const job = await manager.createJobPullRequests(started.jobId);
  assert.equal(job.pullRequests[0]?.status, "not-created");
  assert.match(job.pullRequests[0]?.error ?? "", /invalid GITHUB_TOKEN/i);
}

async function testBuildPullRequestFailureMessageAddsGitHubTokenHint(): Promise<void> {
  const message = buildPullRequestFailureMessage(
    "failed to create pull request",
    [
      "github.com",
      "  X Failed to log in to github.com using token (GITHUB_TOKEN)",
      "  - Active account: true",
      "  - The token in GITHUB_TOKEN is invalid.",
      "  ",
      "  ✓ Logged in to github.com account PixelatedCaptain (keyring)",
      "  - Active account: false"
    ].join("\n")
  );

  assert.match(message, /invalid GITHUB_TOKEN is taking precedence/i);
}

async function testDoctorDetectsGitHubTokenPrecedenceConflict(): Promise<void> {
  const check = analyzeGitHubAuthStatus(
    [
      "github.com",
      "  X Failed to log in to github.com using token (GITHUB_TOKEN)",
      "  - Active account: true",
      "  - The token in GITHUB_TOKEN is invalid.",
      "  ",
      "  ✓ Logged in to github.com account PixelatedCaptain (keyring)",
      "  - Active account: false",
      "  - Token scopes: 'repo'"
    ].join("\n")
  );

  assert.equal(check.status, "warn");
  assert.match(check.detail ?? "", /invalid GITHUB_TOKEN/i);
}

async function testGitHubConflictDetectionHelper(): Promise<void> {
  const conflicted = hasGitHubTokenPrecedenceConflict(
    [
      "github.com",
      "X Failed to log in to github.com using token (GITHUB_TOKEN)",
      "The token in GITHUB_TOKEN is invalid.",
      "Logged in to github.com account PixelatedCaptain (keyring)",
      "Active account: false"
    ].join("\n")
  );
  assert.equal(conflicted, true);
}

async function testCreatePullRequestRetriesWithoutGitHubTokenWhenKeyringLoginExists(): Promise<void> {
  let sawRetryWithoutToken = false;
  let callCount = 0;
  const runner = async (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ): Promise<{ stdout: string; stderr: string }> => {
    callCount += 1;
    if (command !== "gh") {
      throw new Error("unexpected command");
    }

    if (args[0] === "auth" && args[1] === "status") {
      return {
        stdout: [
          "github.com",
          "X Failed to log in to github.com using token (GITHUB_TOKEN)",
          "The token in GITHUB_TOKEN is invalid.",
          "Logged in to github.com account PixelatedCaptain (keyring)",
          "Active account: false"
        ].join("\n"),
        stderr: ""
      };
    }

    if (args[0] === "pr" && args[1] === "create") {
      if (options.env && !("GITHUB_TOKEN" in options.env)) {
        sawRetryWithoutToken = true;
        return {
          stdout: "https://github.com/example/repo/pull/123",
          stderr: ""
        };
      }

      throw new Error("HTTP 401: Bad credentials");
    }

    throw new Error("unexpected gh invocation");
  };

  const created = await createPullRequestWithRunner(
    {
      repoPath: "C:\\repo",
      baseBranch: "main",
      headBranch: "feature/test",
      title: "Title",
      body: "Body",
      draft: true
    },
    runner
  );

  assert.equal(callCount >= 3, true);
  assert.equal(sawRetryWithoutToken, true);
  assert.equal(created.status, "draft");
  assert.equal(created.number, 123);
}

async function testCreatePullRequestReturnsExistingPullRequestWhenRetryFindsOne(): Promise<void> {
  const runner = async (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ): Promise<{ stdout: string; stderr: string }> => {
    if (command !== "gh") {
      throw new Error("unexpected command");
    }

    if (args[0] === "auth" && args[1] === "status") {
      return {
        stdout: [
          "github.com",
          "X Failed to log in to github.com using token (GITHUB_TOKEN)",
          "The token in GITHUB_TOKEN is invalid.",
          "Logged in to github.com account PixelatedCaptain (keyring)",
          "Active account: false"
        ].join("\n"),
        stderr: ""
      };
    }

    if (args[0] === "pr" && args[1] === "create") {
      if (options.env && !("GITHUB_TOKEN" in options.env)) {
        throw new Error(
          [
            'a pull request for branch "feature/test" into branch "main" already exists:',
            "https://github.com/example/repo/pull/77"
          ].join("\n")
        );
      }

      throw new Error("HTTP 401: Bad credentials");
    }

    throw new Error("unexpected gh invocation");
  };

  const created = await createPullRequestWithRunner(
    {
      repoPath: "C:\\repo",
      baseBranch: "main",
      headBranch: "feature/test",
      title: "Title",
      body: "Body",
      draft: true
    },
    runner
  );

  assert.equal(created.status, "open");
  assert.equal(created.number, 77);
  assert.equal(created.url, "https://github.com/example/repo/pull/77");
}

async function testPushMergeAndPrSkipNoOpBranches(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-noop-branches-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  await mkdir(repo, { recursive: true });
  await ensureFelixDirectories(root);

  await runCommand("git", ["init", "--initial-branch=main"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "felix@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Felix Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repo });
  await runCommand("git", ["init", "--bare", remote]);
  await runCommand("git", ["remote", "add", "origin", remote], { cwd: repo });
  await runCommand("git", ["push", "-u", "origin", "main"], { cwd: repo });

  const changedBranch = "agent/changed/job-noop-test-changed";
  const noopBranch = "agent/noop/job-noop-test-noop";

  await runCommand("git", ["checkout", "-b", changedBranch], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\nchanged\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "changed"], { cwd: repo });
  await runCommand("git", ["checkout", "main"], { cwd: repo });
  await runCommand("git", ["checkout", "-b", noopBranch], { cwd: repo });
  await runCommand("git", ["checkout", "main"], { cwd: repo });

  const timestamp = new Date().toISOString();
  const jobId = "20260407-noop-branches";
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  await store.saveJob({
    schemaVersion: 1,
    jobId,
    status: "completed",
    repoPath: repo,
    repoRoot: repo,
    task: "noop branches",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 2,
    autoResume: false,
    maxResumesPerItem: 2,
    planningSummary: "noop branches",
    workItems: [
      {
        id: "changed",
        title: "Changed",
        prompt: "changed",
        issueRefs: [],
        dependsOn: [],
        status: "completed",
        attempts: 1,
        branchName: changedBranch,
        completedAt: timestamp
      },
      {
        id: "noop",
        title: "Noop",
        prompt: "noop",
        issueRefs: [],
        dependsOn: [],
        status: "completed",
        attempts: 1,
        branchName: noopBranch,
        completedAt: timestamp
      }
    ],
    sessions: [],
    events: [],
    mergeReadiness: {
      completedBranches: [changedBranch, noopBranch],
      pendingBranches: [],
      branchReadiness: [],
      generatedAt: timestamp
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const manager = await createJobManager(root);
  const pushed = await manager.pushJobBranches(jobId);
  assert.equal(pushed.remoteBranches.find((branch) => branch.workItemId === "changed")?.pushStatus, "up-to-date");
  assert.equal(pushed.remoteBranches.find((branch) => branch.workItemId === "noop")?.pushStatus, "branch-not-pushed");

  const prs = await manager.createJobPullRequests(jobId);
  assert.doesNotMatch(prs.pullRequests.find((entry) => entry.workItemId === "changed")?.error ?? "", /no changes relative to the target branch/i);
  assert.equal(prs.pullRequests.find((entry) => entry.workItemId === "noop")?.status, "not-created");
  assert.match(prs.pullRequests.find((entry) => entry.workItemId === "noop")?.error ?? "", /no changes relative to the target branch/i);

  const merged = await manager.mergeJobBranches(jobId);
  assert.equal(merged.mergeAutomation.status, "merged");
  assert.deepEqual(merged.mergeAutomation.mergedBranches, [changedBranch]);
}

async function testResolveJobMergeConflictsPersistsResolution(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-resolve-conflicts-"));
  await ensureFelixDirectories(root);
  let unresolved = true;
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store: new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir }),
    runMergeAutomation: async (job) => ({
      targetBranch: "main",
      mergeBranchName: `agent/merge/job-${job.jobId.slice(0, 8)}`,
      mergedBranches: [job.workItems[0].branchName as string],
      pendingBranches: [],
      conflicts: [
        {
          sourceBranch: job.workItems[1].branchName as string,
          files: ["src/shared.ts"]
        }
      ],
      status: "conflicted",
      workspacePath: path.join(root, ".felixai", "merges", job.jobId),
      attemptedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: "merge conflict"
    }),
    resolveMergeConflicts: async (job) => ({
      ...job.mergeAutomation,
      status: unresolved ? "conflicted" : "merged",
      conflicts: unresolved ? job.mergeAutomation.conflicts : [],
      resolutionSessionId: "session-resolve",
      resolutionSummary: unresolved ? "Conflicts still remain" : "Conflicts resolved successfully",
      error: unresolved ? "Conflicts remain after resolution attempt." : undefined,
      completedAt: new Date().toISOString()
    }),
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId, _baseBranch, _repoRoot, issueRefs) =>
        createFakeWorkspaceForIssues(root, jobId, workItemId, issueRefs)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "resolve conflicts",
      workItems: [
        { id: "api", title: "API", prompt: "API", dependsOn: [], issueRefs: ["142"] },
        { id: "ui", title: "UI", prompt: "UI", dependsOn: [], issueRefs: ["143"] }
      ]
    }),
    executor: async ({ prompt }): Promise<ExecutionResult> => ({
      status: "completed",
      summary: `${prompt} done`,
      sessionId: `session-${prompt.toLowerCase()}`
    })
  });

  const started = await manager.startJob({
    repoPath: root,
    task: "resolve conflicts"
  });
  await manager.mergeJobBranches(started.jobId);

  const unresolvedJob = await manager.resolveJobMergeConflicts(started.jobId);
  assert.equal(unresolvedJob.mergeAutomation.status, "conflicted");
  assert.equal(unresolvedJob.mergeAutomation.resolutionSessionId, "session-resolve");

  unresolved = false;
  const resolvedJob = await manager.resolveJobMergeConflicts(started.jobId);
  assert.equal(resolvedJob.mergeAutomation.status, "merged");
  assert.equal(resolvedJob.mergeAutomation.conflicts.length, 0);
  assert.equal(resolvedJob.mergeAutomation.resolutionSummary, "Conflicts resolved successfully");
}

async function testCommitAllChangesCreatesCommitForDirtyWorkspace(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-commit-workspace-"));
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });

  await runCommand("git", ["init"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "felix@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Felix Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repo });

  await writeFile(path.join(repo, "README.md"), "# Test\nupdated\n", "utf8");

  const committed = await commitAllChanges(repo, "felixai: complete WI-1 - Update readme");
  assert.equal(committed, true);

  const status = await runCommand("git", ["status", "--porcelain"], { cwd: repo });
  assert.equal(status.stdout, "");

  const log = await runCommand("git", ["log", "--oneline", "-n", "1"], { cwd: repo });
  assert.match(log.stdout, /felixai: complete WI-1/);
}

async function testGetBranchPushStatusChecksActualRemoteBranch(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-push-status-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  await mkdir(repo, { recursive: true });

  await runCommand("git", ["init", "--initial-branch=main"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "felix@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Felix Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repo });
  await runCommand("git", ["init", "--bare", remote]);
  await runCommand("git", ["remote", "add", "origin", remote], { cwd: repo });
  await runCommand("git", ["push", "-u", "origin", "main"], { cwd: repo });

  await runCommand("git", ["checkout", "-b", "feature/push-status"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test\nremote status\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "feature"], { cwd: repo });
  await runCommand("git", ["push", "-u", "origin", "feature/push-status"], { cwd: repo });

  const synced = await getBranchPushStatus(repo, "feature/push-status", "origin");
  assert.equal(synced.existsRemotely, true);
  assert.equal(synced.pushStatus, "up-to-date");

  await writeFile(path.join(repo, "README.md"), "# Test\nremote status\nahead\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "ahead"], { cwd: repo });

  const ahead = await getBranchPushStatus(repo, "feature/push-status", "origin");
  assert.equal(ahead.existsRemotely, true);
  assert.equal(ahead.pushStatus, "ahead-of-remote");
  assert.equal(ahead.aheadBy > 0, true);
}

async function testRealMergeConflictResolutionKeepsConflictedWorkspaceUntilResolved(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-real-merge-conflict-"));
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await ensureFelixDirectories(root);

  await runCommand("git", ["init", "--initial-branch=main"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "felix@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Felix Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n\nBase line\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repo });

  const branchA = "agent/a/job-real-conflict-a";
  const branchB = "agent/b/job-real-conflict-b";

  await runCommand("git", ["checkout", "-b", branchA], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n\nConflict scenario A\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "scenario-a"], { cwd: repo });

  await runCommand("git", ["checkout", "main"], { cwd: repo });
  await runCommand("git", ["checkout", "-b", branchB], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n\nConflict scenario B\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "scenario-b"], { cwd: repo });
  await runCommand("git", ["checkout", "main"], { cwd: repo });

  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    resolveRepoContext: async () => ({
      repoRoot: repo,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "unused",
      workItems: []
    }),
    executor: async ({ workspacePath }): Promise<ExecutionResult> => {
      const readmePath = path.join(workspacePath, "README.md");
      const conflicted = await runCommand("git", ["-C", workspacePath, "diff", "--name-only", "--diff-filter=U"]);
      assert.match(conflicted.stdout, /README\.md/);
      setTimeout(() => {
        void writeFile(readmePath, "# Test Repo\n\nResolved merge conflict\n", "utf8");
      }, 250);
      return {
        status: "completed",
        summary: "Resolved README conflict",
        sessionId: "session-resolve-real"
      };
    }
  });

  const timestamp = new Date().toISOString();
  const jobId = "20260407-real-conflict";
  await store.saveJob({
    schemaVersion: 1,
    jobId,
    status: "completed",
    repoPath: repo,
    repoRoot: repo,
    task: "real conflict resolution",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 2,
    autoResume: false,
    maxResumesPerItem: 2,
    planningSummary: "real conflict resolution",
    workItems: [
      {
        id: "A",
        title: "Conflict branch A",
        prompt: "unused",
        issueRefs: [],
        dependsOn: [],
        status: "completed",
        attempts: 1,
        branchName: branchA,
        completedAt: timestamp
      },
      {
        id: "B",
        title: "Conflict branch B",
        prompt: "unused",
        issueRefs: [],
        dependsOn: [],
        status: "completed",
        attempts: 1,
        branchName: branchB,
        completedAt: timestamp
      }
    ],
    sessions: [],
    events: [],
    mergeReadiness: {
      completedBranches: [branchA, branchB],
      pendingBranches: [],
      branchReadiness: [],
      generatedAt: timestamp
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const merged = await manager.mergeJobBranches(jobId);
  assert.equal(merged.mergeAutomation.status, "conflicted");
  const mergeWorkspace = merged.mergeAutomation.workspacePath as string;
  const conflictedFiles = await runCommand("git", ["-C", mergeWorkspace, "diff", "--name-only", "--diff-filter=U"]);
  assert.match(conflictedFiles.stdout, /README\.md/);

  const lockPath = (
    await runCommand("git", ["-C", mergeWorkspace, "rev-parse", "--path-format=absolute", "--git-path", "index.lock"])
  ).stdout;
  await writeFile(lockPath, "locked", "utf8");
  const releaseLock = setTimeout(() => {
    void unlink(lockPath).catch(() => undefined);
  }, 1_500);

  const resolved = await manager.resolveJobMergeConflicts(jobId);
  clearTimeout(releaseLock);
  await unlink(lockPath).catch(() => undefined);
  assert.equal(resolved.mergeAutomation.status, "merged");
  assert.equal(resolved.mergeAutomation.conflicts.length, 0);
  assert.equal(resolved.mergeAutomation.resolutionSessionId, "session-resolve-real");

  const readme = await readFile(path.join(mergeWorkspace, "README.md"), "utf8");
  assert.match(readme, /Resolved merge conflict/);
  const status = await runCommand("git", ["-C", mergeWorkspace, "status", "--porcelain"]);
  assert.equal(status.stdout, "");
  const log = await runCommand("git", ["-C", mergeWorkspace, "log", "--oneline", "-n", "1"]);
  assert.match(log.stdout, /Merge branch/);
}

async function testResolveMergeConflictsTreatsCleanGitStateAsResolvedEvenWhenExecutorReportsBoundary(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-real-merge-boundary-"));
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await ensureFelixDirectories(root);

  await runCommand("git", ["init", "--initial-branch=main"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "felix@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Felix Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n\nBase line\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repo });

  const branchA = "agent/a/job-real-boundary-a";
  const branchB = "agent/b/job-real-boundary-b";

  await runCommand("git", ["checkout", "-b", branchA], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n\nConflict scenario A\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "scenario-a"], { cwd: repo });

  await runCommand("git", ["checkout", "main"], { cwd: repo });
  await runCommand("git", ["checkout", "-b", branchB], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n\nConflict scenario B\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repo });
  await runCommand("git", ["commit", "-m", "scenario-b"], { cwd: repo });
  await runCommand("git", ["checkout", "main"], { cwd: repo });

  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    resolveRepoContext: async () => ({
      repoRoot: repo,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "unused",
      workItems: []
    }),
    executor: async ({ workspacePath }): Promise<ExecutionResult> => {
      const conflicted = await runCommand("git", ["-C", workspacePath, "diff", "--name-only", "--diff-filter=U"]);
      assert.match(conflicted.stdout, /README\.md/);
      await writeFile(path.join(workspacePath, "README.md"), "# Test Repo\n\nResolved merge conflict\n", "utf8");
      return {
        status: "blocked",
        summary: "Resolved file but could not stage inside sandbox",
        sessionId: "session-resolve-boundary"
      };
    }
  });

  const timestamp = new Date().toISOString();
  const jobId = "20260408-real-boundary";
  await store.saveJob({
    schemaVersion: 1,
    jobId,
    status: "completed",
    repoPath: repo,
    repoRoot: repo,
    task: "real conflict resolution boundary",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 2,
    autoResume: false,
    maxResumesPerItem: 2,
    planningSummary: "real conflict resolution boundary",
    workItems: [
      {
        id: "A",
        title: "Conflict branch A",
        prompt: "unused",
        issueRefs: [],
        dependsOn: [],
        status: "completed",
        attempts: 1,
        branchName: branchA,
        completedAt: timestamp
      },
      {
        id: "B",
        title: "Conflict branch B",
        prompt: "unused",
        issueRefs: [],
        dependsOn: [],
        status: "completed",
        attempts: 1,
        branchName: branchB,
        completedAt: timestamp
      }
    ],
    sessions: [],
    events: [],
    mergeReadiness: {
      completedBranches: [branchA, branchB],
      pendingBranches: [],
      branchReadiness: [],
      generatedAt: timestamp
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const merged = await manager.mergeJobBranches(jobId);
  assert.equal(merged.mergeAutomation.status, "conflicted");

  const resolved = await manager.resolveJobMergeConflicts(jobId);
  assert.equal(resolved.mergeAutomation.status, "merged");
  assert.equal(resolved.mergeAutomation.conflicts.length, 0);
  assert.equal(resolved.mergeAutomation.resolutionSessionId, "session-resolve-boundary");

  const mergeWorkspace = resolved.mergeAutomation.workspacePath as string;
  const status = await runCommand("git", ["-C", mergeWorkspace, "status", "--porcelain"]);
  assert.equal(status.stdout, "");
}

async function testCliForcesProcessExitWhenHandlesRemainOpen(): Promise<void> {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const cliUrl = pathToFileURL(cliPath).href;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `process.argv = ['node', ${JSON.stringify(cliPath)}, 'version'];`,
          "setInterval(() => {}, 60_000);",
          `await import(${JSON.stringify(cliUrl)});`
        ].join("\n")
      ],
      { stdio: "pipe" }
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("CLI process did not exit while a keepalive handle was open."));
    }, 10_000);

    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `CLI exited with code ${code}. stdout=${Buffer.concat(stdout).toString("utf8")} stderr=${Buffer.concat(stderr).toString("utf8")}`
          )
        );
        return;
      }

      const output = Buffer.concat(stdout).toString("utf8");
      assert.match(output, /\[felixai\] version:/);
      resolve();
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function testCliStatusHighlightsBranchDriftFailures(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-cli-branch-drift-"));
  await ensureFelixDirectories(root);

  const jobId = "branch-drift-cli";
  const timestamp = new Date().toISOString();
  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", `${jobId}.json`), {
    schemaVersion: 1,
    jobId,
    status: "failed",
    repoPath: root,
    repoRoot: root,
    task: "branch drift cli",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    planningSummary: "branch drift cli",
    workItems: [
      {
        id: "api",
        title: "API",
        prompt: "API",
        issueRefs: [],
        dependsOn: [],
        status: "failed",
        attempts: 1,
        workspacePath: path.join(root, ".felixai", "workspaces", jobId, "api"),
        branchName: "agent/api/job-branch-drift-cli-api",
        error: "Workspace branch drift detected: expected 'agent/api/job-branch-drift-cli-api' but Codex left the workspace on 'agent/drifted-branch'.",
        failureCategory: "git",
        retryable: true,
        manualReviewRequired: true,
        startedAt: timestamp
      }
    ],
    sessions: [
      {
        workItemId: "api",
        sessionId: "session-drift",
        status: "failed",
        workspacePath: path.join(root, ".felixai", "workspaces", jobId, "api"),
        branchName: "agent/api/job-branch-drift-cli-api",
        attemptCount: 1,
        lastPrompt: "API",
        updatedAt: timestamp,
        error: "Workspace branch drift detected: expected 'agent/api/job-branch-drift-cli-api' but Codex left the workspace on 'agent/drifted-branch'.",
        failureCategory: "git",
        retryable: true,
        manualReviewRequired: true
      }
    ],
    events: [
      {
        timestamp,
        level: "error",
        scope: "session",
        workItemId: "api",
        message: "Work item failed [git]: Workspace branch drift detected."
      }
    ],
    mergeReadiness: {
      completedBranches: [],
      pendingBranches: ["agent/api/job-branch-drift-cli-api"],
      branchReadiness: [],
      generatedAt: timestamp
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const output = await runCommand(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "job", "status", jobId], {
    cwd: root
  });

  assert.match(output.stdout, /\[felixai\] action required: branch drift detected/);
  assert.match(output.stdout, /\[felixai\] branch drift api: expected=agent\/api\/job-branch-drift-cli-api/);
  assert.match(output.stdout, /\[felixai\] branch drift detail: Workspace branch drift detected:/);
}

async function testCliStatusHighlightsStaleRunningWorkItems(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-running-status-"));
  await ensureFelixDirectories(root);

  const jobId = "20260408-running-stale";
  const oldTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", `${jobId}.json`), {
    schemaVersion: 1,
    jobId,
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "stale running item",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    planningSummary: "stale running",
    workItems: [
      {
        id: "slow",
        title: "Slow item",
        prompt: "Slow item",
        issueRefs: [],
        dependsOn: [],
        status: "running",
        attempts: 1,
        workspacePath: path.join(root, ".felixai", "workspaces", jobId, "slow"),
        branchName: "agent/slow/job-running-stale",
        startedAt: oldTimestamp
      }
    ],
    sessions: [
      {
        workItemId: "slow",
        sessionId: "slow-session",
        status: "running",
        workspacePath: path.join(root, ".felixai", "workspaces", jobId, "slow"),
        branchName: "agent/slow/job-running-stale",
        attemptCount: 1,
        lastPrompt: "Slow item",
        progressSummary: "changed_files=2 recent=src/A.cs, tests/A.Tests.cs last_file_update=45s_ago",
        changedFilesCount: 2,
        recentChangedFiles: ["src/A.cs", "tests/A.Tests.cs"],
        lastWorkspaceActivityAt: oldTimestamp,
        promptChars: 420,
        promptLines: 12,
        transcriptEventCount: 38,
        toolCallCount: 9,
        toolOutputCount: 9,
        reasoningCount: 4,
        updatedAt: oldTimestamp
      }
    ],
    events: [],
    mergeReadiness: {
      completedBranches: [],
      pendingBranches: ["agent/slow/job-running-stale"],
      branchReadiness: [],
      generatedAt: oldTimestamp
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp
  });

  const output = await runCommand(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "job", "status", jobId], {
    cwd: root
  });

  assert.match(output.stdout, /\[felixai\] slow: running .*running_for=/);
  assert.match(output.stdout, /\[felixai\] slow: running .*signal=stale/);
  assert.match(output.stdout, /\[felixai\] slow: running .*changed_files=2/);
  assert.match(output.stdout, /\[felixai\] slow: running .*prompt_chars=420/);
  assert.match(output.stdout, /\[felixai\] slow: running .*transcript_events=38/);
  assert.match(output.stdout, /\[felixai\] slow: running .*tool_calls=9/);
  assert.match(output.stdout, /\[felixai\] slow: running .*reasoning_events=4/);
  assert.match(output.stdout, /\[felixai\] slow: recent_changed=src\/A\.cs, tests\/A\.Tests\.cs/);
  assert.match(output.stdout, /\[felixai\] slow: progress=changed_files=2 recent=src\/A\.cs, tests\/A\.Tests\.cs/);
  assert.match(output.stdout, /\[felixai\] action required: running work item may be stalled/);
}

async function testCliJobListShowsReadableSessionBlocks(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-job-list-summary-"));
  await ensureFelixDirectories(root);

  const jobId = "20260410-job-list";
  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", `${jobId}.json`), {
    schemaVersion: 1,
    jobId,
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: [
      "GitHub issue #109: Finish remaining secret access-boundary coverage for launch",
      "Execution phase: implementation",
      "",
      "Operator directive: review github issues labeled as app-ready and tell me the top 3 that we should implement now",
      "",
      "Issue body:",
      "A very long body that should never appear in job list."
    ].join("\n"),
    issueRefs: ["109"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: true,
    maxResumesPerItem: 2,
    planningSummary: "summary",
    workItems: [
      {
        id: "WI-109-1",
        title: "summary",
        prompt: "summary",
        issueRefs: ["109"],
        dependsOn: [],
        status: "running",
        attempts: 1
      }
    ],
    sessions: [
      {
        workItemId: "WI-109-1",
        status: "running",
        attemptCount: 1,
        sessionId: "session-109",
        changedFilesCount: 3,
        recentChangedFiles: ["src/Theme.ts", "src/Theme.css", "tests/Theme.test.ts"],
        lastWorkspaceActivityAt: new Date(Date.now() - 45_000).toISOString(),
        updatedAt: nowIso()
      }
    ],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  const output = await runCommand(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "job", "list"], {
    cwd: root
  });

  assert.match(output.stdout, /Job ID: 20260410-job-list/);
  assert.match(output.stdout, /Status: running/);
  assert.match(output.stdout, /Branch: main/);
  assert.match(output.stdout, /Issues: #109/);
  assert.match(output.stdout, /Session: session-109/);
  assert.match(output.stdout, /Phase: implementation/);
  assert.match(output.stdout, /Changed Files: 3/);
  assert.match(output.stdout, /Last File Update: \d+s ago/);
  assert.match(output.stdout, /Recent Files: src\/Theme\.ts, src\/Theme\.css, tests\/Theme\.test\.ts/);
  assert.match(output.stdout, /Work Items: done=0\/1 running=1 failed=0/);
  assert.match(output.stdout, /Task: GitHub issue #109: Finish remaining secret access-boundary coverage for launch/);
  assert.match(output.stdout, /GitHub issue #109: Finish remaining secret access-boundary coverage for launch/);
  assert.doesNotMatch(output.stdout, /Operator directive:/);
  assert.doesNotMatch(output.stdout, /Issue body:/);
}

async function testCliJobListShowsOnlyCurrentShellSessionJobsByDefault(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-job-list-shell-scope-"));
  await ensureFelixDirectories(root);
  await saveCurrentShellSession(root, root, {
    shellSessionId: "shell-current",
    repoRoot: root,
    startedAt: nowIso()
  });

  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", "job-current.json"), {
    schemaVersion: 1,
    jobId: "job-current",
    shellSessionId: "shell-current",
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "Work GitHub issue #130: Theming.",
    issueRefs: ["130"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", "job-old.json"), {
    schemaVersion: 1,
    jobId: "job-old",
    shellSessionId: "shell-old",
    status: "failed",
    repoPath: root,
    repoRoot: root,
    task: "Work GitHub issue #109: Old failure.",
    issueRefs: ["109"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: false,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  const output = await runCommand(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "job", "list"], {
    cwd: root
  });

  assert.match(output.stdout, /Job ID: job-current/);
  assert.doesNotMatch(output.stdout, /Job ID: job-old/);
}

async function testArchiveStaleActiveJobsRemovesOnlyDeadActiveState(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-archive-stale-jobs-"));
  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "unused",
      workItems: [{ id: "unused", title: "unused", prompt: "unused", dependsOn: [] }]
    }),
    executor: async (): Promise<ExecutionResult> => ({
      status: "completed",
      summary: "unused"
    })
  });

  const oldTimestamp = new Date(Date.now() - 16 * 60_000).toISOString();
  const freshTimestamp = new Date(Date.now() - 2 * 60_000).toISOString();

  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", "stale-running.json"), {
    schemaVersion: 1,
    jobId: "stale-running",
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "stale running task",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 1,
    autoResume: true,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp
  });

  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", "fresh-running.json"), {
    schemaVersion: 1,
    jobId: "fresh-running",
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "fresh running task",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 1,
    autoResume: true,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: freshTimestamp,
    updatedAt: freshTimestamp
  });

  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", "paused-old.json"), {
    schemaVersion: 1,
    jobId: "paused-old",
    status: "paused",
    repoPath: root,
    repoRoot: root,
    task: "paused old task",
    issueRefs: [],
    baseBranch: "main",
    parallelism: 1,
    autoResume: true,
    maxResumesPerItem: 2,
    workItems: [],
    sessions: [],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp
  });

  const archived = await manager.archiveStaleActiveJobs({ repoRoot: root, staleAfterMs: 15 * 60_000 });
  const visibleJobs = await manager.listJobs();

  assert.deepEqual(archived.map((job) => job.jobId), ["stale-running"]);
  assert.deepEqual(
    visibleJobs.map((job) => job.jobId).sort(),
    ["fresh-running", "paused-old"]
  );
  assert.equal(await pathExists(path.join(root, ".felixai", "state", "archive", "jobs", "stale-running.json")), true);
}

async function testRunningJobPersistsCodexSessionIdBeforeCompletion(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-session-start-"));
  await ensureFelixDirectories(root);
  const store = new StateStore(root, { stateDir: DEFAULT_CONFIG.stateDir, logDir: DEFAULT_CONFIG.logDir });
  let releaseExecution: (() => void) | undefined;

  const manager = new JobManager({
    config: DEFAULT_CONFIG,
    store,
    resolveRepoContext: async () => ({
      repoRoot: root,
      baseBranch: "main",
      dirtyWorkingTree: false
    }),
    workspaceManager: {
      ensureWorkspace: async (jobId, workItemId) => createFakeWorkspace(root, jobId, workItemId)
    },
    planner: async (): Promise<PlanResult> => ({
      summary: "session start",
      workItems: [{ id: "alpha", title: "Alpha", prompt: "Alpha", dependsOn: [] }]
    }),
    executor: async ({ onSessionReady }): Promise<ExecutionResult> => {
      await onSessionReady?.("session-alpha");
      await new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      return {
        status: "completed",
        summary: "done",
        sessionId: "session-alpha"
      };
    }
  });

  const jobPromise = manager.startJob({
    repoPath: root,
    task: "session start"
  });

  let running: JobState | undefined;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const jobs = await manager.listJobs();
    const candidate = jobs.find((job) => job.workItems.some((item) => item.id === "alpha"));
    if (candidate?.sessions.find((session) => session.workItemId === "alpha")?.sessionId === "session-alpha") {
      running = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(running?.workItems.find((item) => item.id === "alpha")?.sessionId, "session-alpha");
  assert.equal(running?.sessions.find((session) => session.workItemId === "alpha")?.sessionId, "session-alpha");
  assert.equal(running?.events.some((event) => /Codex session started: session-alpha/.test(event.message)), true);

  releaseExecution?.();
  const completed = await jobPromise;
  assert.equal(completed.status, "completed");
}

async function testCliJobWatchReportsStartupStateWithoutSession(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-job-watch-starting-"));
  await ensureFelixDirectories(root);

  const jobId = "20260410-starting-watch";
  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", `${jobId}.json`), {
    schemaVersion: 1,
    jobId,
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "starting watch task",
    issueRefs: ["109"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: true,
    maxResumesPerItem: 2,
    planningSummary: "summary",
    workItems: [
      {
        id: "felix-109-1",
        title: "startup",
        prompt: "startup",
        issueRefs: ["109"],
        dependsOn: [],
        status: "running",
        attempts: 1
      }
    ],
    sessions: [
      {
        workItemId: "felix-109-1",
        status: "running",
        attemptCount: 1,
        updatedAt: nowIso()
      }
    ],
    events: [],
    mergeReadiness: { completedBranches: [], pendingBranches: [], branchReadiness: [] },
    mergeAutomation: { targetBranch: "main", mergedBranches: [], pendingBranches: [], conflicts: [], status: "pending" },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  const output = await runCommand(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "job", "watch", jobId, "--no-follow"], {
    cwd: root
  }).catch((error: Error & { stdout?: string; stderr?: string }) => error);

  const combined = `${"stdout" in output ? output.stdout ?? "" : ""}${"stderr" in output ? output.stderr ?? "" : ""}`;
  assert.match(combined, /still starting; no Codex session has been established yet/i);
}

async function testCliSessionWatchPrintsTranscriptTail(): Promise<void> {
  const originalUserProfile = process.env.USERPROFILE;
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-cli-session-watch-"));
  const sessionId = "019d76f8-17ba-7ba3-bb0c-46a7fbe09bb8";
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "04", "10");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, `rollout-2026-04-10T05-37-43-${sessionId}.jsonl`),
    [
      JSON.stringify({
        timestamp: "2026-04-10T10:39:18.048Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-10T10:39:18.298Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "Exit code: 0\r\nOutput:\r\nok\r\n"
        }
      })
    ].join("\n"),
    "utf8"
  );

  process.env.USERPROFILE = root;
  try {
    const output = await runCommand(
      process.execPath,
      [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "session", "watch", sessionId, "--no-follow", "--lines", "10"],
      { cwd: root, env: { ...process.env } }
    );

    assert.match(output.stdout, /\[felixai\] transcript:/);
    assert.match(output.stdout, /tool call shell_command/);
    assert.match(output.stdout, /tool output Exit code: 0/);
  } finally {
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function testCliJobWatchResolvesRunningSessionTranscript(): Promise<void> {
  const originalUserProfile = process.env.USERPROFILE;
  const root = await mkdtemp(path.join(os.tmpdir(), "felix-cli-job-watch-"));
  await ensureFelixDirectories(root);

  const jobId = "20260410-job-watch";
  const sessionId = "019d76f8-17ba-7ba3-bb0c-46a7fbe09bb8";
  await writeJsonFile(path.join(root, ".felixai", "state", "jobs", `${jobId}.json`), {
    schemaVersion: 1,
    jobId,
    status: "running",
    repoPath: root,
    repoRoot: root,
    task: "watch running issue",
    issueRefs: ["109"],
    baseBranch: "main",
    parallelism: 1,
    autoResume: true,
    maxResumesPerItem: 2,
    planningSummary: "watch",
    workItems: [
      {
        id: "WI-109-1",
        title: "Watch me",
        prompt: "Watch me",
        issueRefs: ["109"],
        dependsOn: [],
        status: "running",
        attempts: 1,
        branchName: "agent/issue-109/job-watch",
        workspacePath: path.join(root, ".felixai", "workspaces", jobId, "WI-109-1"),
        startedAt: new Date().toISOString()
      }
    ],
    sessions: [
      {
        workItemId: "WI-109-1",
        sessionId,
        status: "running",
        workspacePath: path.join(root, ".felixai", "workspaces", jobId, "WI-109-1"),
        branchName: "agent/issue-109/job-watch",
        attemptCount: 1,
        updatedAt: new Date().toISOString()
      }
    ],
    events: [],
    mergeReadiness: {
      completedBranches: [],
      pendingBranches: ["agent/issue-109/job-watch"],
      branchReadiness: [],
      generatedAt: new Date().toISOString()
    },
    mergeAutomation: {
      targetBranch: "main",
      mergedBranches: [],
      pendingBranches: [],
      conflicts: [],
      status: "pending"
    },
    remoteBranches: [],
    pullRequests: [],
    issueSummaries: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const sessionDir = path.join(root, ".codex", "sessions", "2026", "04", "10");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, `rollout-2026-04-10T05-37-43-${sessionId}.jsonl`),
    JSON.stringify({
      timestamp: "2026-04-10T10:39:18.048Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command"
      }
    }),
    "utf8"
  );

  process.env.USERPROFILE = root;
  try {
    const output = await runCommand(
      process.execPath,
      [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"), "job", "watch", jobId, "--no-follow"],
      { cwd: root, env: { ...process.env } }
    );

    assert.match(output.stdout, /\[felixai\] watching WI-109-1 session=/);
    assert.match(output.stdout, /tool call shell_command/);
    assert.match(output.stdout, /\[felixai\] watch log:/);

    const watchLogPath = path.join(
      root,
      ".felixai",
      "state",
      "watch-logs",
      `${createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12)}-${jobId}-WI-109-1-${sessionId}.log`
    );
    const watchLog = await readFile(watchLogPath, "utf8");
    assert.match(watchLog, /tool call shell_command/);
  } finally {
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testInit();
  await testDefaultReasoningEffortIsMedium();
  await testCodexCliIssueSessionStopsPromptlyAfterTaskComplete();
  await testCodexModelCatalogLoadsDynamicEntriesAndCurrentModel();
  await testUnsupportedCodexModelErrorDetection();
  await testRunCommandResolvesWindowsCmdShims();
  await testInvalidConfigFailsValidation();
  await testLegacyCredentialModesMigrateToCodex();
  await testPlanningPromptDiscouragesVerificationOnlyWorkItems();
  await testIssuePlanningPromptAndValidation();
  await testIssueLabelingPromptAndValidation();
  await testPlanRefinementCollapsesCoupledTestWorkItems();
  await testPlanRefinementKeepsIndependentWorkItemsSplit();
  await testPlannerAndExecutionFlow();
  await testStartJobLoadsRepoAgentsInstructionsAndPassesThemToPlannerAndExecutor();
  await testRepoAgentsPreferencesPersistModelAndReasoning();
  await testRepoAgentsPreferencesParseExecutionPolicy();
  await testCliConfigSetPersistsRepoModelAndReasoning();
  await testNormalizeGitHubIssuesAndSnapshotPersistence();
  await testGitHubIssueMetadataParserAcceptsTrailingDoneCriteriaBullets();
  await testIssueWaveSelectionPrefersParallelSafeLowOverlapIssues();
  await testIssueRunnerPersistsRunStateAndStopsOnBlockedIssue();
  await testIssueRunnerDoesNotRetryBlockedJobs();
  await testCodexSessionTranscriptDiscoveryAndFormatting();
  await testTranscriptFormatterHandlesDirectResponseItemsAndSuppressesRawNoise();
  await testIssueRunnerFiltersToExplicitIssuesAndStopsAfterFirstRequestedImplementation();
  await testIssueRunnerTransitionsFromImplementationToValidationPhase();
  await testIssueRunnerValidationFinalizesBranchAndArchivesSupersededJobs();
  await testIssueRunnerArchivesOlderCompletedJobsButKeepsCurrentJob();
  await testIssueRunnerReusesSameSessionForValidationWhenJobAutoResumed();
  await testIssueRunnerReusesSameSessionWhenImplementationNeedsAnotherTurn();
  await testLooksLikeIssueDrivenDirectiveDetectsGitHubIssuePrompt();
  await testLooksLikePlanThenExecuteDirectiveDetectsMixedIntent();
  await testLooksLikeIssueLabelingDirectiveDetectsLabelWork();
  await testClassifyTopLevelInputRoutesKnownCommandsIssuesAndRepoPrompts();
  await testResumeFlow();
  await testLongRunningExecutionPersistsHeartbeatWarning();
  await testInvalidStateFailsValidation();
  await testRequireCleanRejectsDirtyRepo();
  await testBaseBranchFailureBubblesClearly();
  await testDuplicatePlanIdsFail();
  await testMissingDependencyFails();
  await testCircularDependencyFails();
  await testMergeReadinessIsPersisted();
  await testSchedulerStartsDependentWorkWithoutWaitingForWholeWave();
  await testIssueRefsPropagateToJobsAndBranches();
  await testRemoteBranchMetadataAndIssueSummariesPersist();
  await testWorkspaceManagerReusesAndReattachesExistingWorktrees();
  await testWorkspaceManagerUsesUniqueBranchNamesPerJob();
  await testWorkspaceConflictIsClassifiedAndPersisted();
  await testBranchDriftFailsWorkItemInsteadOfRecordingWrongBranch();
  await testBlockedExecutionIsPersistedForManualReview();
  await testPushJobBranchesRefreshesRemoteState();
  await testMergeAutomationPersistsSuccessAndConflict();
  await testCreateJobPullRequestsPersistsLinks();
  await testCreateJobPullRequestsPersistsFailureReason();
  await testBuildPullRequestFailureMessageAddsGitHubTokenHint();
  await testDoctorDetectsGitHubTokenPrecedenceConflict();
  await testGitHubConflictDetectionHelper();
  await testCreatePullRequestRetriesWithoutGitHubTokenWhenKeyringLoginExists();
  await testCreatePullRequestReturnsExistingPullRequestWhenRetryFindsOne();
  await testPushMergeAndPrSkipNoOpBranches();
  await testResolveJobMergeConflictsPersistsResolution();
  await testCommitAllChangesCreatesCommitForDirtyWorkspace();
  await testGetBranchPushStatusChecksActualRemoteBranch();
  await testRealMergeConflictResolutionKeepsConflictedWorkspaceUntilResolved();
  await testCliForcesProcessExitWhenHandlesRemainOpen();
  await testCliStatusHighlightsBranchDriftFailures();
  await testCliStatusHighlightsStaleRunningWorkItems();
  await testCliJobListShowsReadableSessionBlocks();
  await testCliJobListShowsOnlyCurrentShellSessionJobsByDefault();
  await testArchiveStaleActiveJobsRemovesOnlyDeadActiveState();
  await testStateStoreLoadsArchivedJobs();
  await testRunningJobPersistsCodexSessionIdBeforeCompletion();
  await testCliJobWatchReportsStartupStateWithoutSession();
  await testCliSessionWatchPrintsTranscriptTail();
  await testCliJobWatchResolvesRunningSessionTranscript();
  console.log("job manager tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
