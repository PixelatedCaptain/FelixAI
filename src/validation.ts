import { STATE_SCHEMA_VERSION, type FelixConfig, type JobState, type PlanResult, type PlannedWorkItem } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
}

function assertBoolean(value: unknown, message: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }
}

function assertPositiveInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
}

function assertNonNegativeInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(message);
  }
}

function assertStringArray(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(message);
  }
}

function assertOptionalStringArray(value: unknown, message: string): asserts value is string[] | undefined {
  if (value === undefined) {
    return;
  }
  assertStringArray(value, message);
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], message: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${message} Allowed values: ${allowed.join(", ")}`);
  }
}

export function migrateConfig(raw: unknown): FelixConfig {
  if (!isRecord(raw)) {
    throw new Error("FelixAI config must be a JSON object.");
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion === undefined || schemaVersion === STATE_SCHEMA_VERSION) {
    const migrated = { ...raw } as Record<string, unknown>;
    if (
      migrated.credentialSource === "chatgpt-session" ||
      migrated.credentialSource === "env-api-key" ||
      migrated.credentialSource === undefined
    ) {
      migrated.credentialSource = "codex";
    }
    return migrated as unknown as FelixConfig;
  }

  throw new Error(`Unsupported FelixAI config schema version '${String(schemaVersion)}'.`);
}

export function validateConfig(config: FelixConfig): FelixConfig {
  assertRecord(config, "FelixAI config must be a JSON object.");
  assertPositiveInteger(config.schemaVersion, "FelixAI config must include a positive integer schemaVersion.");
  assertString(config.stateDir, "FelixAI config must include stateDir.");
  assertString(config.workspaceRoot, "FelixAI config must include workspaceRoot.");
  assertString(config.logDir, "FelixAI config must include logDir.");
  if (config.defaultBaseBranch !== undefined) {
    assertString(config.defaultBaseBranch, "FelixAI config defaultBaseBranch must be a non-empty string.");
  }
  assertEnum(config.credentialSource, ["codex"], "FelixAI config credentialSource is invalid.");
  assertRecord(config.git, "FelixAI config must include a git object.");
  assertBoolean(config.git.allowDirtyWorkingTree, "FelixAI git.allowDirtyWorkingTree must be a boolean.");

  assertRecord(config.codex, "FelixAI config must include a codex object.");
  assertEnum(config.codex.approvalPolicy, ["never", "on-request", "on-failure", "untrusted"], "FelixAI approvalPolicy is invalid.");
  assertEnum(config.codex.sandboxMode, ["read-only", "workspace-write", "danger-full-access"], "FelixAI sandboxMode is invalid.");
  assertEnum(config.codex.modelReasoningEffort, ["minimal", "low", "medium", "high", "xhigh"], "FelixAI modelReasoningEffort is invalid.");
  assertEnum(config.codex.webSearchMode, ["disabled", "cached", "live"], "FelixAI webSearchMode is invalid.");
  assertBoolean(config.codex.networkAccessEnabled, "FelixAI networkAccessEnabled must be a boolean.");
  assertPositiveInteger(config.codex.parallelism, "FelixAI parallelism must be a positive integer.");
  assertBoolean(config.codex.autoResume, "FelixAI autoResume must be a boolean.");
  assertPositiveInteger(config.codex.maxResumesPerItem, "FelixAI maxResumesPerItem must be a positive integer.");

  return config;
}

export function migrateJobState(raw: unknown): JobState {
  if (!isRecord(raw)) {
    throw new Error("FelixAI job state must be a JSON object.");
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion === undefined || schemaVersion === STATE_SCHEMA_VERSION) {
    const migrated = { ...raw } as Record<string, unknown>;
    if (!isRecord(migrated.mergeAutomation)) {
      migrated.mergeAutomation = {
        targetBranch: typeof migrated.baseBranch === "string" ? migrated.baseBranch : "main",
        mergedBranches: [],
        pendingBranches: [],
        conflicts: [],
        status: "pending"
      };
    }
    if (!Array.isArray(migrated.pullRequests)) {
      migrated.pullRequests = [];
    }
    return migrated as unknown as JobState;
  }

  throw new Error(`Unsupported FelixAI job state schema version '${String(schemaVersion)}'.`);
}

export function validateJobState(job: JobState): JobState {
  assertRecord(job, "FelixAI job state must be a JSON object.");
  assertPositiveInteger(job.schemaVersion, "Job state schemaVersion must be a positive integer.");
  assertString(job.jobId, "Job state jobId must be a non-empty string.");
  assertEnum(job.status, ["planning", "ready", "running", "paused", "completed", "failed"], "Job state status is invalid.");
  assertString(job.repoPath, "Job state repoPath must be a non-empty string.");
  assertString(job.repoRoot, "Job state repoRoot must be a non-empty string.");
  assertString(job.task, "Job state task must be a non-empty string.");
  assertStringArray(job.issueRefs, "Job state issueRefs must be an array of strings.");
  assertString(job.baseBranch, "Job state baseBranch must be a non-empty string.");
  assertPositiveInteger(job.parallelism, "Job state parallelism must be a positive integer.");
  assertBoolean(job.autoResume, "Job state autoResume must be a boolean.");
  assertPositiveInteger(job.maxResumesPerItem, "Job state maxResumesPerItem must be a positive integer.");
  if (job.planningSummary !== undefined) {
    assertString(job.planningSummary, "Job state planningSummary must be a non-empty string when present.");
  }
  if (!Array.isArray(job.workItems)) {
    throw new Error("Job state workItems must be an array.");
  }
  if (!Array.isArray(job.sessions)) {
    throw new Error("Job state sessions must be an array.");
  }
  if (!Array.isArray(job.events)) {
    throw new Error("Job state events must be an array.");
  }
  assertRecord(job.mergeReadiness, "Job state mergeReadiness must be an object.");
  assertStringArray(job.mergeReadiness.completedBranches, "Job state completedBranches must be an array of strings.");
  assertStringArray(job.mergeReadiness.pendingBranches, "Job state pendingBranches must be an array of strings.");
  if (!Array.isArray(job.mergeReadiness.branchReadiness)) {
    throw new Error("Job state branchReadiness must be an array.");
  }
  for (const branch of job.mergeReadiness.branchReadiness) {
    assertRecord(branch, "Each branch readiness entry must be an object.");
    assertString(branch.workItemId, "Each branch readiness entry must include workItemId.");
    assertString(branch.branchName, "Each branch readiness entry must include branchName.");
    assertStringArray(branch.changedFiles, "Each branch readiness changedFiles value must be an array of strings.");
    assertStringArray(branch.conflictWith, "Each branch readiness conflictWith value must be an array of strings.");
  }
  assertRecord(job.mergeAutomation, "Job state mergeAutomation must be an object.");
  if (job.mergeAutomation.mergeBranchName !== undefined) {
    assertString(job.mergeAutomation.mergeBranchName, "Job state mergeAutomation.mergeBranchName must be a non-empty string when present.");
  }
  assertString(job.mergeAutomation.targetBranch, "Job state mergeAutomation.targetBranch must be a non-empty string.");
  assertStringArray(job.mergeAutomation.mergedBranches, "Job state mergeAutomation.mergedBranches must be an array of strings.");
  assertStringArray(job.mergeAutomation.pendingBranches, "Job state mergeAutomation.pendingBranches must be an array of strings.");
  assertEnum(job.mergeAutomation.status, ["pending", "merged", "conflicted", "failed"], "Job state mergeAutomation.status is invalid.");
  if (job.mergeAutomation.workspacePath !== undefined) {
    assertString(job.mergeAutomation.workspacePath, "Job state mergeAutomation.workspacePath must be a non-empty string when present.");
  }
  if (job.mergeAutomation.resolutionSessionId !== undefined) {
    assertString(job.mergeAutomation.resolutionSessionId, "Job state mergeAutomation.resolutionSessionId must be a non-empty string when present.");
  }
  if (job.mergeAutomation.resolutionSummary !== undefined) {
    assertString(job.mergeAutomation.resolutionSummary, "Job state mergeAutomation.resolutionSummary must be a non-empty string when present.");
  }
  if (job.mergeAutomation.attemptedAt !== undefined) {
    assertString(job.mergeAutomation.attemptedAt, "Job state mergeAutomation.attemptedAt must be a non-empty string when present.");
  }
  if (job.mergeAutomation.completedAt !== undefined) {
    assertString(job.mergeAutomation.completedAt, "Job state mergeAutomation.completedAt must be a non-empty string when present.");
  }
  if (job.mergeAutomation.error !== undefined) {
    assertString(job.mergeAutomation.error, "Job state mergeAutomation.error must be a non-empty string when present.");
  }
  if (!Array.isArray(job.mergeAutomation.conflicts)) {
    throw new Error("Job state mergeAutomation.conflicts must be an array.");
  }
  for (const conflict of job.mergeAutomation.conflicts) {
    assertRecord(conflict, "Each merge conflict entry must be an object.");
    assertString(conflict.sourceBranch, "Each merge conflict entry must include sourceBranch.");
    assertStringArray(conflict.files, "Each merge conflict entry files must be an array of strings.");
  }
  if (!Array.isArray(job.remoteBranches)) {
    throw new Error("Job state remoteBranches must be an array.");
  }
  if (!Array.isArray(job.pullRequests)) {
    throw new Error("Job state pullRequests must be an array.");
  }
  for (const pullRequest of job.pullRequests) {
    assertRecord(pullRequest, "Each pull request entry must be an object.");
    assertString(pullRequest.workItemId, "Each pull request entry must include workItemId.");
    assertString(pullRequest.sourceBranch, "Each pull request entry must include sourceBranch.");
    assertString(pullRequest.targetBranch, "Each pull request entry must include targetBranch.");
    assertStringArray(pullRequest.issueRefs, "Each pull request entry issueRefs must be an array of strings.");
    assertString(pullRequest.title, "Each pull request entry must include title.");
    assertString(pullRequest.body, "Each pull request entry must include body.");
    if (pullRequest.compareUrl !== undefined) {
      assertString(pullRequest.compareUrl, "Each pull request entry compareUrl must be a non-empty string when present.");
    }
    if (pullRequest.pullRequestNumber !== undefined) {
      assertPositiveInteger(pullRequest.pullRequestNumber, "Each pull request entry pullRequestNumber must be a positive integer when present.");
    }
    if (pullRequest.pullRequestUrl !== undefined) {
      assertString(pullRequest.pullRequestUrl, "Each pull request entry pullRequestUrl must be a non-empty string when present.");
    }
    if (pullRequest.error !== undefined) {
      assertString(pullRequest.error, "Each pull request entry error must be a non-empty string when present.");
    }
    assertEnum(pullRequest.status, ["not-created", "draft", "open", "merged", "closed"], "Pull request status is invalid.");
    assertString(pullRequest.updatedAt, "Each pull request entry updatedAt must be a non-empty string.");
  }
  for (const branch of job.remoteBranches) {
    assertRecord(branch, "Each remote branch entry must be an object.");
    assertString(branch.workItemId, "Each remote branch entry must include workItemId.");
    assertString(branch.branchName, "Each remote branch entry must include branchName.");
    assertStringArray(branch.issueRefs, "Each remote branch entry issueRefs must be an array of strings.");
    if (branch.remoteName !== undefined) {
      assertString(branch.remoteName, "Each remote branch entry remoteName must be a non-empty string when present.");
    }
    if (branch.remoteUrl !== undefined) {
      assertString(branch.remoteUrl, "Each remote branch entry remoteUrl must be a non-empty string when present.");
    }
    if (branch.remoteBranchName !== undefined) {
      assertString(branch.remoteBranchName, "Each remote branch entry remoteBranchName must be a non-empty string when present.");
    }
    assertBoolean(branch.existsRemotely, "Each remote branch entry existsRemotely must be a boolean.");
    assertEnum(
      branch.pushStatus,
      ["no-remote", "branch-not-pushed", "up-to-date", "ahead-of-remote", "behind-remote", "diverged", "unknown"],
      "Remote branch pushStatus is invalid."
    );
    assertNonNegativeInteger(branch.aheadBy, "Each remote branch entry aheadBy must be zero or greater.");
    assertNonNegativeInteger(branch.behindBy, "Each remote branch entry behindBy must be zero or greater.");
    if (branch.checkedAt !== undefined) {
      assertString(branch.checkedAt, "Each remote branch entry checkedAt must be a non-empty string when present.");
    }
  }
  if (!Array.isArray(job.issueSummaries)) {
    throw new Error("Job state issueSummaries must be an array.");
  }
  for (const summary of job.issueSummaries) {
    assertRecord(summary, "Each issue summary must be an object.");
    assertString(summary.issueRef, "Each issue summary must include issueRef.");
    assertEnum(summary.status, ["not_started", "in_progress", "blocked", "completed"], "Issue summary status is invalid.");
    assertStringArray(summary.workItemIds, "Each issue summary workItemIds value must be an array of strings.");
    assertStringArray(summary.completedWorkItemIds, "Each issue summary completedWorkItemIds value must be an array of strings.");
    assertStringArray(summary.pendingWorkItemIds, "Each issue summary pendingWorkItemIds value must be an array of strings.");
    assertStringArray(summary.failedWorkItemIds, "Each issue summary failedWorkItemIds value must be an array of strings.");
    assertStringArray(summary.branchNames, "Each issue summary branchNames value must be an array of strings.");
    assertStringArray(summary.remoteBranches, "Each issue summary remoteBranches value must be an array of strings.");
    if (summary.latestResponse !== undefined) {
      assertString(summary.latestResponse, "Each issue summary latestResponse must be a non-empty string when present.");
    }
    assertString(summary.updatedAt, "Each issue summary updatedAt must be a non-empty string.");
  }
  assertString(job.createdAt, "Job state createdAt must be a non-empty string.");
  assertString(job.updatedAt, "Job state updatedAt must be a non-empty string.");

  for (const item of job.workItems) {
    assertRecord(item, "Each work item must be an object.");
    assertString(item.id, "Each work item must include id.");
    assertString(item.title, "Each work item must include title.");
    assertString(item.prompt, "Each work item must include prompt.");
    assertEnum(item.status, ["pending", "running", "boundary", "blocked", "completed", "failed"], `Work item '${item.id}' has an invalid status.`);
    assertNonNegativeInteger(item.attempts, `Work item '${item.id}' attempts must be zero or greater.`);
    assertStringArray(item.dependsOn, `Work item '${item.id}' dependsOn must be an array of strings.`);
    assertOptionalStringArray(item.issueRefs, `Work item '${item.id}' issueRefs must be an array of strings when present.`);
    if (item.failureCategory !== undefined) {
      assertEnum(
        item.failureCategory,
        ["workspace-conflict", "workspace-missing", "workspace-setup", "git", "execution-boundary", "execution-blocked", "execution-error", "unknown"],
        `Work item '${item.id}' failureCategory is invalid.`
      );
    }
    if (item.retryable !== undefined) {
      assertBoolean(item.retryable, `Work item '${item.id}' retryable must be a boolean when present.`);
    }
    if (item.manualReviewRequired !== undefined) {
      assertBoolean(item.manualReviewRequired, `Work item '${item.id}' manualReviewRequired must be a boolean when present.`);
    }
  }

  for (const session of job.sessions) {
    assertRecord(session, "Each session must be an object.");
    assertString(session.workItemId, "Each session must include workItemId.");
    assertEnum(session.status, ["pending", "running", "boundary", "blocked", "completed", "failed"], `Session '${session.workItemId}' has an invalid status.`);
    assertPositiveInteger(session.attemptCount, `Session '${session.workItemId}' attemptCount must be a positive integer.`);
    assertString(session.updatedAt, `Session '${session.workItemId}' updatedAt must be a non-empty string.`);
    if (session.progressSummary !== undefined) {
      assertString(session.progressSummary, `Session '${session.workItemId}' progressSummary must be a non-empty string when present.`);
    }
    if (session.changedFilesCount !== undefined) {
      assertNonNegativeInteger(session.changedFilesCount, `Session '${session.workItemId}' changedFilesCount must be a non-negative integer when present.`);
    }
    if (session.recentChangedFiles !== undefined) {
      assertStringArray(session.recentChangedFiles, `Session '${session.workItemId}' recentChangedFiles must be an array of strings when present.`);
    }
    if (session.lastWorkspaceActivityAt !== undefined) {
      assertString(session.lastWorkspaceActivityAt, `Session '${session.workItemId}' lastWorkspaceActivityAt must be a non-empty string when present.`);
    }
    if (session.failureCategory !== undefined) {
      assertEnum(
        session.failureCategory,
        ["workspace-conflict", "workspace-missing", "workspace-setup", "git", "execution-boundary", "execution-blocked", "execution-error", "unknown"],
        `Session '${session.workItemId}' failureCategory is invalid.`
      );
    }
    if (session.retryable !== undefined) {
      assertBoolean(session.retryable, `Session '${session.workItemId}' retryable must be a boolean when present.`);
    }
    if (session.manualReviewRequired !== undefined) {
      assertBoolean(session.manualReviewRequired, `Session '${session.workItemId}' manualReviewRequired must be a boolean when present.`);
    }
  }

  for (const event of job.events) {
    assertRecord(event, "Each event must be an object.");
    assertString(event.timestamp, "Each event must include timestamp.");
    assertEnum(event.level, ["info", "warn", "error"], "Job event level is invalid.");
    assertEnum(event.scope, ["job", "planner", "workspace", "session"], "Job event scope is invalid.");
    assertString(event.message, "Job event message must be a non-empty string.");
  }

  return job;
}

export function readTaskFromJson(raw: unknown): string {
  assertRecord(raw, "Task file must contain a JSON object.");
  assertString(raw.task, "Task file must include a non-empty string task field.");
  return raw.task;
}

export function validatePlanResult(plan: PlanResult): PlanResult {
  assertRecord(plan, "Planner output must be a JSON object.");
  assertString(plan.summary, "Planner output must include a non-empty summary.");
  if (!Array.isArray(plan.workItems) || plan.workItems.length === 0) {
    throw new Error("Planner output must include a non-empty workItems array.");
  }

  const ids = new Set<string>();
  for (const item of plan.workItems) {
    validatePlannedWorkItem(item);
    if (ids.has(item.id)) {
      throw new Error(`Planner returned duplicate work item id '${item.id}'.`);
    }
    ids.add(item.id);
  }

  for (const item of plan.workItems) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Work item '${item.id}' depends on missing work item '${dependency}'.`);
      }
      if (dependency === item.id) {
        throw new Error(`Work item '${item.id}' cannot depend on itself.`);
      }
    }
  }

  assertAcyclicPlan(plan.workItems);
  return plan;
}

const TEST_RELATED_PATTERN =
  /\b(test|tests|testing|unit test|integration test|e2e|spec|specs|coverage|verify|verification|validate|validation|assert)\b/i;

export function refinePlanResult(plan: PlanResult): PlanResult {
  let workItems = [...plan.workItems];
  let collapsedCount = 0;

  while (true) {
    const mergeCandidate = findCoupledWorkItemPair(workItems);
    if (!mergeCandidate) {
      break;
    }

    workItems = collapseDependentWorkItem(workItems, mergeCandidate.parentId, mergeCandidate.childId);
    collapsedCount += 1;
  }

  if (collapsedCount === 0) {
    return plan;
  }

  const summarySuffix =
    collapsedCount === 1
      ? "FelixAI collapsed 1 coupled verification item into its parent work item before execution."
      : `FelixAI collapsed ${collapsedCount} coupled verification items into parent work items before execution.`;

  return {
    ...plan,
    summary: `${plan.summary} ${summarySuffix}`.trim(),
    workItems
  };
}

function validatePlannedWorkItem(item: PlannedWorkItem): void {
  assertRecord(item, "Each planner work item must be an object.");
  assertString(item.id, "Each planner work item must include id.");
  assertString(item.title, "Each planner work item must include title.");
  assertString(item.prompt, "Each planner work item must include prompt.");
  assertStringArray(item.dependsOn, `Planner work item '${item.id}' dependsOn must be an array of strings.`);
  assertOptionalStringArray(item.issueRefs, `Planner work item '${item.id}' issueRefs must be an array of strings when present.`);
}

function findCoupledWorkItemPair(
  workItems: PlannedWorkItem[]
): {
  parentId: string;
  childId: string;
} | undefined {
  const byId = new Map(workItems.map((item) => [item.id, item]));

  for (const item of workItems) {
    if (item.dependsOn.length !== 1 || !isLikelyVerificationItem(item)) {
      continue;
    }

    const parent = byId.get(item.dependsOn[0]);
    if (!parent || isLikelyVerificationItem(parent)) {
      continue;
    }

    return {
      parentId: parent.id,
      childId: item.id
    };
  }

  return undefined;
}

function isLikelyVerificationItem(item: PlannedWorkItem): boolean {
  const text = `${item.title} ${item.prompt}`;
  return TEST_RELATED_PATTERN.test(text);
}

function collapseDependentWorkItem(
  workItems: PlannedWorkItem[],
  parentId: string,
  childId: string
): PlannedWorkItem[] {
  const parent = workItems.find((item) => item.id === parentId);
  const child = workItems.find((item) => item.id === childId);
  if (!parent || !child) {
    return workItems;
  }

  const mergedParent: PlannedWorkItem = {
    ...parent,
    title: mergeTitles(parent.title, child.title),
    prompt: mergePrompts(parent.prompt, child.prompt),
    dependsOn: [...new Set(parent.dependsOn)],
    issueRefs: mergeIssueRefs(parent.issueRefs, child.issueRefs)
  };

  return workItems
    .filter((item) => item.id !== childId)
    .map((item) => {
      if (item.id === parentId) {
        return mergedParent;
      }

      if (!item.dependsOn.includes(childId)) {
        return item;
      }

      return {
        ...item,
        dependsOn: [...new Set(item.dependsOn.map((dependency) => (dependency === childId ? parentId : dependency)))]
      };
    });
}

function mergeTitles(parentTitle: string, childTitle: string): string {
  return parentTitle === childTitle ? parentTitle : `${parentTitle} and ${childTitle}`.slice(0, 160);
}

function mergePrompts(parentPrompt: string, childPrompt: string): string {
  if (parentPrompt.includes(childPrompt)) {
    return parentPrompt;
  }

  return `${parentPrompt}\n\nAlso complete this coupled follow-up in the same work item:\n${childPrompt}`;
}

function mergeIssueRefs(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

function assertAcyclicPlan(workItems: PlannedWorkItem[]): void {
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, trail: string[]): void {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`Planner returned a circular dependency: ${[...trail, id].join(" -> ")}`);
    }

    visiting.add(id);
    const item = byId.get(id);
    if (!item) {
      return;
    }
    for (const dependency of item.dependsOn) {
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const item of workItems) {
    visit(item.id, []);
  }
}
