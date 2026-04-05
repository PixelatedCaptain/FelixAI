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
    return raw as unknown as FelixConfig;
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
  assertEnum(config.credentialSource, ["chatgpt-session", "env-api-key"], "FelixAI config credentialSource is invalid.");
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
    return raw as unknown as JobState;
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
  assertString(job.createdAt, "Job state createdAt must be a non-empty string.");
  assertString(job.updatedAt, "Job state updatedAt must be a non-empty string.");

  for (const item of job.workItems) {
    assertRecord(item, "Each work item must be an object.");
    assertString(item.id, "Each work item must include id.");
    assertString(item.title, "Each work item must include title.");
    assertString(item.prompt, "Each work item must include prompt.");
    assertEnum(item.status, ["pending", "running", "boundary", "completed", "failed"], `Work item '${item.id}' has an invalid status.`);
    assertNonNegativeInteger(item.attempts, `Work item '${item.id}' attempts must be zero or greater.`);
    assertStringArray(item.dependsOn, `Work item '${item.id}' dependsOn must be an array of strings.`);
    assertOptionalStringArray(item.issueRefs, `Work item '${item.id}' issueRefs must be an array of strings when present.`);
  }

  for (const session of job.sessions) {
    assertRecord(session, "Each session must be an object.");
    assertString(session.workItemId, "Each session must include workItemId.");
    assertEnum(session.status, ["pending", "running", "boundary", "completed", "failed"], `Session '${session.workItemId}' has an invalid status.`);
    assertPositiveInteger(session.attemptCount, `Session '${session.workItemId}' attemptCount must be a positive integer.`);
    assertString(session.updatedAt, `Session '${session.workItemId}' updatedAt must be a non-empty string.`);
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

function validatePlannedWorkItem(item: PlannedWorkItem): void {
  assertRecord(item, "Each planner work item must be an object.");
  assertString(item.id, "Each planner work item must include id.");
  assertString(item.title, "Each planner work item must include title.");
  assertString(item.prompt, "Each planner work item must include prompt.");
  assertStringArray(item.dependsOn, `Planner work item '${item.id}' dependsOn must be an array of strings.`);
  assertOptionalStringArray(item.issueRefs, `Planner work item '${item.id}' issueRefs must be an array of strings when present.`);
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
