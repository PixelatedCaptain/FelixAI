import type { ApprovalMode, ModelReasoningEffort, SandboxMode, WebSearchMode } from "@openai/codex-sdk";

export const STATE_SCHEMA_VERSION = 1;

export type CredentialSource = "codex";
export type JobStatus = "planning" | "ready" | "running" | "paused" | "completed" | "failed";
export type WorkItemStatus = "pending" | "running" | "boundary" | "blocked" | "completed" | "failed";
export type SessionStatus = "pending" | "running" | "boundary" | "blocked" | "completed" | "failed";
export type EventLevel = "info" | "warn" | "error";
export type PushStatus = "no-remote" | "branch-not-pushed" | "up-to-date" | "ahead-of-remote" | "behind-remote" | "diverged" | "unknown";
export type IssueRunStatus = "not_started" | "in_progress" | "blocked" | "completed";
export type MergeAttemptStatus = "pending" | "merged" | "conflicted" | "failed";
export type PullRequestStatus = "not-created" | "draft" | "open" | "merged" | "closed";
export type FailureCategory =
  | "workspace-conflict"
  | "workspace-missing"
  | "workspace-setup"
  | "git"
  | "execution-boundary"
  | "execution-blocked"
  | "execution-error"
  | "unknown";

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
  shellSessionId?: string;
  initialSessionId?: string;
  initialBranchName?: string;
  initialWorkspacePath?: string;
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
  failureCategory?: FailureCategory;
  retryable?: boolean;
  manualReviewRequired?: boolean;
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
  progressSummary?: string;
  changedFilesCount?: number;
  recentChangedFiles?: string[];
  lastWorkspaceActivityAt?: string;
  promptChars?: number;
  promptLines?: number;
  transcriptEventCount?: number;
  toolCallCount?: number;
  toolOutputCount?: number;
  reasoningCount?: number;
  updatedAt: string;
  error?: string;
  failureCategory?: FailureCategory;
  retryable?: boolean;
  manualReviewRequired?: boolean;
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

export interface RemoteBranchState {
  workItemId: string;
  branchName: string;
  issueRefs: string[];
  remoteName?: string;
  remoteUrl?: string;
  remoteBranchName?: string;
  existsRemotely: boolean;
  pushStatus: PushStatus;
  aheadBy: number;
  behindBy: number;
  checkedAt?: string;
}

export interface IssueRunSummary {
  issueRef: string;
  status: IssueRunStatus;
  workItemIds: string[];
  completedWorkItemIds: string[];
  pendingWorkItemIds: string[];
  failedWorkItemIds: string[];
  branchNames: string[];
  remoteBranches: string[];
  latestResponse?: string;
  updatedAt: string;
}

export interface PullRequestLink {
  workItemId: string;
  sourceBranch: string;
  targetBranch: string;
  issueRefs: string[];
  title: string;
  body: string;
  compareUrl?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  error?: string;
  status: PullRequestStatus;
  updatedAt: string;
}

export interface MergeConflict {
  sourceBranch: string;
  files: string[];
}

export interface MergeAutomationState {
  mergeBranchName?: string;
  targetBranch: string;
  mergedBranches: string[];
  pendingBranches: string[];
  conflicts: MergeConflict[];
  status: MergeAttemptStatus;
  workspacePath?: string;
  resolutionSessionId?: string;
  resolutionSummary?: string;
  attemptedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface JobState {
  schemaVersion: number;
  jobId: string;
  shellSessionId?: string;
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
  mergeAutomation: MergeAutomationState;
  remoteBranches: RemoteBranchState[];
  pullRequests: PullRequestLink[];
  issueSummaries: IssueRunSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAssignment {
  branchName: string;
  workspacePath: string;
  mode?: "created" | "reused" | "reattached";
  cleanupPerformed?: boolean;
}

export interface ExecutionResult {
  sessionId?: string;
  status: "completed" | "needs_resume" | "blocked";
  summary: string;
  nextPrompt?: string;
  telemetry?: {
    promptChars?: number;
    promptLines?: number;
    transcriptEventCount?: number;
    toolCallCount?: number;
    toolOutputCount?: number;
    reasoningCount?: number;
  };
}
