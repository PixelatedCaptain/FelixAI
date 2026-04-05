import type { ApprovalMode, ModelReasoningEffort, SandboxMode, WebSearchMode } from "@openai/codex-sdk";

export const STATE_SCHEMA_VERSION = 1;

export type CredentialSource = "chatgpt-session" | "env-api-key";
export type JobStatus = "planning" | "ready" | "running" | "paused" | "completed" | "failed";
export type WorkItemStatus = "pending" | "running" | "boundary" | "completed" | "failed";
export type SessionStatus = "pending" | "running" | "boundary" | "completed" | "failed";
export type EventLevel = "info" | "warn" | "error";

export interface FelixConfig {
  schemaVersion: number;
  stateDir: string;
  workspaceRoot: string;
  logDir: string;
  defaultBaseBranch?: string;
  credentialSource: CredentialSource;
  git: {
    allowDirtyWorkingTree: boolean;
  };
  codex: {
    approvalPolicy: ApprovalMode;
    sandboxMode: SandboxMode;
    modelReasoningEffort: ModelReasoningEffort;
    webSearchMode: WebSearchMode;
    networkAccessEnabled: boolean;
    parallelism: number;
    autoResume: boolean;
    maxResumesPerItem: number;
  };
}

export interface JobStartRequest {
  repoPath: string;
  task: string;
  baseBranch?: string;
  parallelism?: number;
  autoResume?: boolean;
  requireClean?: boolean;
  issueRefs?: string[];
}

export interface PlannedWorkItem {
  id: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  issueRefs?: string[];
}

export interface PlanResult {
  summary: string;
  workItems: PlannedWorkItem[];
}

export interface WorkItemState extends PlannedWorkItem {
  status: WorkItemStatus;
  attempts: number;
  workspacePath?: string;
  branchName?: string;
  sessionId?: string;
  lastResponse?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface SessionState {
  workItemId: string;
  sessionId?: string;
  status: SessionStatus;
  workspacePath?: string;
  branchName?: string;
  attemptCount: number;
  lastPrompt?: string;
  lastResponse?: string;
  updatedAt: string;
  error?: string;
}

export interface JobEvent {
  timestamp: string;
  level: EventLevel;
  scope: "job" | "planner" | "workspace" | "session";
  workItemId?: string;
  message: string;
}

export interface BranchReadiness {
  workItemId: string;
  branchName: string;
  changedFiles: string[];
  conflictWith: string[];
}

export interface MergeReadiness {
  completedBranches: string[];
  pendingBranches: string[];
  branchReadiness: BranchReadiness[];
  generatedAt?: string;
}

export interface JobState {
  schemaVersion: number;
  jobId: string;
  status: JobStatus;
  repoPath: string;
  repoRoot: string;
  task: string;
  issueRefs: string[];
  baseBranch: string;
  parallelism: number;
  autoResume: boolean;
  maxResumesPerItem: number;
  planningSummary?: string;
  workItems: WorkItemState[];
  sessions: SessionState[];
  events: JobEvent[];
  mergeReadiness: MergeReadiness;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAssignment {
  branchName: string;
  workspacePath: string;
}

export interface ExecutionResult {
  sessionId?: string;
  status: "completed" | "needs_resume" | "blocked";
  summary: string;
  nextPrompt?: string;
}
