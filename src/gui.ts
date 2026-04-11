import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { findCodexSessionTranscript, formatTranscriptLine, readTranscriptTail } from "./codex-sessions.js";
import { createJobManager } from "./job-manager.js";
import { filterJobsForCurrentShellSession, formatJobListBlock, inferJobPhase } from "./job-presentation.js";
import type { JobState } from "./types.js";

interface GuiOptions {
  repoRoot: string;
  port?: number;
  openBrowser: boolean;
}

function buildGuiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FelixAI Monitor</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #11192d;
      --panel-2: #18233b;
      --text: #e8edf7;
      --muted: #9badc8;
      --accent: #5cc8ff;
      --border: #263552;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Consolas, "Cascadia Code", "Courier New", monospace;
      background: linear-gradient(180deg, #0b1020 0%, #0e1528 100%);
      color: var(--text);
      min-height: 100vh;
    }
    .shell {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tab {
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      padding: 10px 14px;
      cursor: pointer;
      border-radius: 8px;
    }
    .tab.active {
      background: var(--panel-2);
      border-color: var(--accent);
    }
    .panel {
      display: none;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(17, 25, 45, 0.94);
      overflow: hidden;
    }
    .panel.active {
      display: block;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    select, button {
      font: inherit;
      color: var(--text);
      background: #0f1728;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
    }
    button {
      cursor: pointer;
    }
    .content {
      padding: 16px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
    }
    .job-block {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      background: #0d1424;
      margin-bottom: 12px;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
    }
    .watch-empty {
      color: var(--muted);
      padding: 20px 0;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <div>
        <div class="title">FelixAI Monitor</div>
        <div class="meta" id="repoRoot"></div>
      </div>
      <div class="meta" id="lastSync">syncing…</div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="jobs">Job List</button>
      <button class="tab" data-tab="watch">Job Watch</button>
    </div>
    <section id="panel-jobs" class="panel active">
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="hint">Current Felix shell session jobs</span>
        </div>
        <button id="refreshJobs">Refresh</button>
      </div>
      <div class="content">
        <div id="jobsList"></div>
      </div>
    </section>
    <section id="panel-watch" class="panel">
      <div class="toolbar">
        <div class="toolbar-left">
          <label for="jobSelect">Job</label>
          <select id="jobSelect"></select>
        </div>
        <button id="refreshWatch">Refresh</button>
      </div>
      <div class="content">
        <pre id="watchOutput" class="watch-empty">Select a job to watch.</pre>
      </div>
    </section>
  </div>
  <script>
    const state = {
      activeTab: "jobs",
      jobs: [],
      selectedJobId: ""
    };

    function escapeHtml(value) {
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function setTab(tab) {
      state.activeTab = tab;
      document.querySelectorAll(".tab").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tab);
      });
      document.getElementById("panel-jobs").classList.toggle("active", tab === "jobs");
      document.getElementById("panel-watch").classList.toggle("active", tab === "watch");
    }

    function setSyncLabel() {
      document.getElementById("lastSync").textContent = "Last sync: " + new Date().toLocaleTimeString();
    }

    async function refreshJobs() {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      const payload = await response.json();
      state.jobs = payload.jobs;
      document.getElementById("repoRoot").textContent = payload.repoRoot;
      const jobsList = document.getElementById("jobsList");
      jobsList.innerHTML = "";
      if (payload.jobs.length === 0) {
        jobsList.innerHTML = '<div class="hint">No jobs found for the current Felix shell session.</div>';
      } else {
        for (const job of payload.jobs) {
          const block = document.createElement("div");
          block.className = "job-block";
          block.innerHTML = "<pre>" + escapeHtml(job.block) + "</pre>";
          jobsList.appendChild(block);
        }
      }

      const select = document.getElementById("jobSelect");
      const prior = state.selectedJobId;
      select.innerHTML = "";
      for (const job of payload.jobs) {
        const option = document.createElement("option");
        option.value = job.jobId;
        option.textContent = job.jobId + " • " + job.status + (job.phase ? " • " + job.phase : "") + " • " + job.task;
        select.appendChild(option);
      }
      if (payload.jobs.length > 0) {
        state.selectedJobId = payload.jobs.some((job) => job.jobId === prior) ? prior : payload.jobs[0].jobId;
        select.value = state.selectedJobId;
      } else {
        state.selectedJobId = "";
      }

      setSyncLabel();
      await refreshWatch();
    }

    async function refreshWatch() {
      const output = document.getElementById("watchOutput");
      if (!state.selectedJobId) {
        output.textContent = "Select a job to watch.";
        output.className = "watch-empty";
        return;
      }

      const response = await fetch("/api/watch?jobId=" + encodeURIComponent(state.selectedJobId), { cache: "no-store" });
      const payload = await response.json();
      output.className = "";
      output.textContent = payload.lines.join("\\n");
      setSyncLabel();
    }

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => setTab(button.dataset.tab));
    });
    document.getElementById("refreshJobs").addEventListener("click", refreshJobs);
    document.getElementById("refreshWatch").addEventListener("click", refreshWatch);
    document.getElementById("jobSelect").addEventListener("change", (event) => {
      state.selectedJobId = event.target.value;
      refreshWatch();
    });

    setInterval(refreshJobs, 3000);
    refreshJobs();
  </script>
</body>
</html>`;
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function writeHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

function writeNotFound(response: ServerResponse): void {
  response.statusCode = 404;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end("Not found");
}

function resolveJobWatchSession(job: JobState): { workItemId: string; sessionId: string } | { message: string } {
  const startingItem = job.workItems.find((item) => item.status === "running" && !item.sessionId);
  const candidateSessions = job.sessions.filter((session) => Boolean(session.sessionId));

  if (candidateSessions.length === 0) {
    if (startingItem) {
      return { message: `Work item '${startingItem.id}' is still starting; no Codex session has been established yet.` };
    }
    return { message: `No sessions found for job '${job.jobId}'.` };
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

async function handleApiJobs(repoRoot: string, response: ServerResponse): Promise<void> {
  const manager = await createJobManager(repoRoot);
  const listed = await manager.listJobs();
  const { jobs: visibleJobs, shellSessionId } = await filterJobsForCurrentShellSession(repoRoot, listed);
  const jobs = visibleJobs.map((job) => ({
    jobId: job.jobId,
    status: job.status,
    phase: inferJobPhase(job),
    sessionId:
      job.sessions.find((session) => session.status === "running")?.sessionId ??
      job.sessions.find((session) => Boolean(session.sessionId))?.sessionId,
    task: manager.formatJobListSummary(job),
    block: formatJobListBlock(job, manager.formatJobListSummary(job))
  }));
  writeJson(response, { repoRoot, shellSessionId, jobs });
}

async function handleApiWatch(repoRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const jobId = url.searchParams.get("jobId");
  const lineCount = Number.parseInt(url.searchParams.get("lines") ?? "80", 10);
  if (!jobId) {
    writeJson(response, { lines: ["Missing jobId."] });
    return;
  }

  const manager = await createJobManager(repoRoot);
  const job = await manager.getJob(jobId).catch(() => undefined);
  if (!job) {
    writeJson(response, { lines: [`Job '${jobId}' was not found.`] });
    return;
  }

  const resolved = resolveJobWatchSession(job);
  if ("message" in resolved) {
    writeJson(response, { lines: [`[felixai] ${resolved.message}`] });
    return;
  }

  const transcriptPath = await findCodexSessionTranscript(resolved.sessionId);
  if (!transcriptPath) {
    writeJson(response, { lines: [`[felixai] No Codex transcript was found for session '${resolved.sessionId}'.`] });
    return;
  }

  const tail = await readTranscriptTail(transcriptPath, Number.isNaN(lineCount) ? 80 : lineCount);
  writeJson(response, {
    lines: tail.map((line) => formatTranscriptLine(line)),
    sessionId: resolved.sessionId,
    workItemId: resolved.workItemId
  });
}

function openBrowserWindow(url: string): void {
  const options = { detached: true, stdio: "ignore" as const };
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], options).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], options).unref();
    return;
  }
  spawn("xdg-open", [url], options).unref();
}

export async function runGui(options: GuiOptions): Promise<void> {
  const html = buildGuiHtml();
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/") {
        writeHtml(response, html);
        return;
      }
      if (pathname === "/api/jobs") {
        await handleApiJobs(options.repoRoot, response);
        return;
      }
      if (pathname === "/api/watch") {
        await handleApiWatch(options.repoRoot, request, response);
        return;
      }
      writeNotFound(response);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine FelixAI GUI server address.");
  }

  const url = `http://127.0.0.1:${address.port}`;
  console.log(`[felixai] gui: ${url}`);
  console.log("[felixai] gui mode: polling repo-local job state and transcript tails");
  console.log("[felixai] press Ctrl+C to stop the monitor");

  if (options.openBrowser) {
    openBrowserWindow(url);
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
