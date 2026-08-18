import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

import type { LivePipelineTraceRecord } from "../../../src/shared/live-pipeline-trace";

const CLOCK_BASIS = "wall-clock-iso-milliseconds" as const;
type ClockBasis = typeof CLOCK_BASIS;

// The shared watchdog is JavaScript-only and intentionally has no production
// TypeScript dependency. Keep the test seam typed locally at the call site.
// @ts-expect-error The repository test helper is an ESM .mjs module without a declaration file.
import { snapshotProcessTree, terminateProcessTree } from "../../../../scripts/lib/process-watchdog.mjs";

const RUN_LIVENESS = process.env.PIE_RUN_SESSION_RUNTIME_LIVENESS === "1";
const LIVENESS_OPT_IN =
  "Spawned worker liveness is opt-in because it builds a packaged backend twice. " +
  "Set PIE_RUN_SESSION_RUNTIME_LIVENESS=1 to execute both isolated-mode causal scenarios.";
const CONTROL_RESPONSE_DEADLINE_MS = 15_000;
const STARTUP_DEADLINE_MS = 90_000;
const MARKER_DEADLINE_MS = 15_000;
const TRACE_STABILITY_DEADLINE_MS = 2_000;
const IDENTITY_VERIFICATION_DEADLINE_MS = 5_000;
const TRACE_KEY_PREFIX = "phase-0-test-key";
const NO_SUBAGENT_ACTIVITY_REASON = "scenario_has_no_subagent_activity" as const;
const CONTROL_METHODS = ["app.ping", "session.open", "settings.get", "models.list"] as const;
type Scenario = "execution-hook" | "factory";
type BlockingTracePhase = "extension_hook" | "service_loading";
type ControlMethod = (typeof CONTROL_METHODS)[number];
type TimelineMarker =
  | "process.spawned"
  | "process.ready"
  | "phase.entered"
  | "control.response.received"
  | "release.created"
  | "phase.continued"
  | "cleanup.started"
  | "cleanup.completed";

interface RpcResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: unknown;
}

interface ProcessIdentity {
  pid: number;
  ppid: number;
  identity: string | null;
}

interface ProcessCapture {
  captured: ProcessIdentity[];
  rootAliveAtCapture: boolean;
}

interface ProcessCleanup {
  gone: boolean;
  survivors: number[];
  ownedPids: number[];
  captured: ProcessIdentity[];
  rootAliveAtCapture: boolean;
}

interface HarnessTimelineEvent {
  schemaVersion: 1;
  source: "harness";
  seq: number;
  runId: string;
  scenario: Scenario;
  ts: string;
  /** Wall-clock timestamp used for cross-process comparisons. monoMs is local-only. */
  wallMs: number;
  monoMs: number;
  marker: TimelineMarker;
  processRole: "harness" | "backend" | "worker";
  pid?: number;
  phase?: Scenario;
  method?: ControlMethod;
  responseOk?: boolean;
  releasePresent?: boolean;
  reason?: string;
  capturedProcesses?: ProcessIdentity[];
  ownedPids?: number[];
  survivorPids?: number[];
  rootAliveAtCapture?: boolean;
  ownedPidCount?: number;
  survivorPidCount?: number;
  identityVerification?: "gone" | "unavailable";
}

interface BackendTimelineRecord {
  source: "backend";
  record: LivePipelineTraceRecord;
}

type MergedTimelineRecord = HarnessTimelineEvent | BackendTimelineRecord;
type EvidenceStatus = "observed" | "unavailable";

interface PayloadByteMetric {
  status: EvidenceStatus;
  recordCount?: number;
  sourcePayloadBytes?: number;
  producedPayloadBytes?: number;
  reason?: string;
}

type WriterEvidenceBasis =
  | "explicit-active-write-ahead-metadata"
  | "partial-explicit-active-write-ahead-metadata"
  | "unavailable-no-explicit-active-write-ahead-metadata";

interface WriterEvidence {
  status: EvidenceStatus;
  basis: WriterEvidenceBasis;
  responseWriteCount?: number;
  queuedBehind: {
    anotherResponse?: number;
    event?: number;
    activeOsWrite?: number;
  };
  maxObservedQueueDepth?: number;
  observedLanes?: string[];
  reason?: string;
}

interface StallTracePhaseSpan {
  process: string;
  pid?: number;
  processSeq?: number;
  stage: string;
  phase: string;
  kind: string;
  startMs: number;
  endMs: number;
  overlapStartMs: number;
  overlapEndMs: number;
  overlapMs: number;
}

interface BlockingSpanEvidence {
  scenario: Scenario;
  markerPhase: Scenario;
  reason: string;
  traceStage: string;
  tracePhase: BlockingTracePhase;
  pid: number;
  startMs: number;
  endMs: number;
  unreleasedStartMs: number;
  unreleasedEndMs: number;
  overlapStartMs: number;
  overlapEndMs: number;
  overlapMs: number;
  clockBasis: ClockBasis;
}

interface LivenessEvidence {
  clockBasis: ClockBasis;
  blockedWindow: {
    enteredSeq: number;
    releaseSeq: number;
    continuedSeq: number;
    enteredAtMs: number;
    continuedAtMs: number;
  };
  expectedControlMethods: readonly ControlMethod[];
  responseMethodsBeforeRelease: ControlMethod[];
  responseMethodsAfterRelease: ControlMethod[];
  coordinatorResponsiveWhileABlocked: boolean;
  coordinatorResponsiveness: {
    status: "observed";
    answer: boolean;
    basis: "control-response-receipts-before-release";
  };
  synchronousStall: {
    status: "observed";
    owner: string;
    blockingSpan: BlockingSpanEvidence;
    backendTracePhases: string[];
    phaseSpans: StallTracePhaseSpan[];
    requiredPhaseSpan: StallTracePhaseSpan;
    phaseSpanStatus: "observed";
    basis: "scenario-entered-reason-and-overlapping-trace-spans";
    clockBasis: ClockBasis;
  };
  writer: WriterEvidence;
  recursiveBytes: {
    sourceUpdate: PayloadByteMetric;
    compactEvent: PayloadByteMetric;
    detailBaseline: PayloadByteMetric;
    detailPage: PayloadByteMetric;
    detailDelta: PayloadByteMetric;
    detailTerminal: PayloadByteMetric;
    terminalTransport: PayloadByteMetric;
    terminalAppend: PayloadByteMetric;
  };
  /** Counts come from one backend diff record per source observation. */
  sourceUpdateCount: number;
  semanticChanges: number;
  duplicates: number;
  backendTraceRecordCount: number;
  backendTraceStages: string[];
  backendTracePhases: string[];
}

interface LivenessTimelineArtifact {
  schemaVersion: 1;
  kind: "phase-0-liveness-timeline";
  runId: string;
  runIdHash: string;
  scenario: Scenario;
  generatedAt: string;
  records: MergedTimelineRecord[];
  evidence: LivenessEvidence;
}

interface BackendHarness {
  child: ChildProcess;
  stderr: string;
  request(method: string, params?: unknown, timeoutMs?: number, onReceipt?: (response: RpcResponse) => void): Promise<RpcResponse>;
  waitForEvent(event: string, timeoutMs?: number): Promise<unknown>;
  close(onCaptured?: (capture: ProcessCapture) => void): Promise<ProcessCleanup>;
}

function repoPath(...parts: string[]): string {
  const cwd = process.cwd();
  const root = path.basename(cwd).toLowerCase() === "extension" ? path.resolve(cwd, "..") : cwd;
  return path.join(root, ...parts);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await exists(filePath))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for marker ${filePath}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function traceRunIdHash(runId: string, key: string): string {
  return createHmac("sha256", key).update(runId).digest("base64url");
}

type TimelineEventDetails = Partial<Omit<HarnessTimelineEvent, "schemaVersion" | "source" | "seq" | "runId" | "scenario" | "ts" | "wallMs" | "monoMs" | "marker">> & { wallMs?: number };

function createTimeline(runId: string, scenario: Scenario): {
  events: HarnessTimelineEvent[];
  mark: (marker: TimelineMarker, details?: TimelineEventDetails) => HarnessTimelineEvent;
} {
  const events: HarnessTimelineEvent[] = [];
  return {
    events,
    mark(marker, details = {}) {
      const { wallMs: suppliedWallMs, ...rest } = details;
      const wallMs = suppliedWallMs ?? Date.now();
      const event: HarnessTimelineEvent = {
        schemaVersion: 1,
        source: "harness",
        seq: events.length,
        runId,
        scenario,
        ts: new Date(wallMs).toISOString(),
        wallMs,
        monoMs: performance.now(),
        marker,
        ...rest,
        processRole: details.processRole ?? "harness",
      };
      events.push(event);
      return event;
    },
  };
}

function readProcessTable(): ProcessIdentity[] | undefined {
  try {
    if (process.platform === "win32") {
      // Query identity and ancestry only; command lines are deliberately absent.
      const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate }";
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
      return result.stdout.split(/\r?\n/u).flatMap((line) => {
        const [pid, ppid, identity] = line.trim().split("|");
        return Number(pid) > 0 ? [{ pid: Number(pid), ppid: Number(ppid), identity: identity || null }] : [];
      });
    }
    const result = spawnSync("ps", ["-e", "-o", "pid=,ppid=,lstart="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return result.stdout.split(/\r?\n/u).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), identity: match[3] || null }] : [];
    });
  } catch {
    return undefined;
  }
}

async function verifyCapturedIdentitiesGone(captured: ProcessIdentity[]): Promise<{ available: boolean; survivors: ProcessIdentity[] }> {
  const deadline = Date.now() + IDENTITY_VERIFICATION_DEADLINE_MS;
  let current = readProcessTable();
  while (current === undefined || captured.some((entry) => current!.some((row) => row.pid === entry.pid && row.identity === entry.identity))) {
    if (Date.now() >= deadline) {
      return {
        available: current !== undefined,
        survivors: current === undefined ? [] : captured.filter((entry) => current!.some((row) => row.pid === entry.pid && row.identity === entry.identity)),
      };
    }
    await sleep(50);
    current = readProcessTable();
  }
  return { available: true, survivors: [] };
}

async function startProvider(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.end([
        `data: ${JSON.stringify({ id: "phase-0", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
        "",
        `data: ${JSON.stringify({ id: "phase-0", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
}

async function createFixture(dir: string, phase: Scenario, providerPort: number): Promise<{
  agentDir: string;
  workspaceA: string;
  workspaceB: string;
  sessionA: string;
  sessionB: string;
  entered: string;
  release: string;
  continued: string;
  traceDir: string;
  timelinePath: string;
  runId: string;
  traceKey: string;
  runIdHash: string;
}> {
  const agentDir = path.join(dir, "agent");
  const workspaceA = path.join(dir, "workspace-a");
  const workspaceB = path.join(dir, "workspace-b");
  const sessionDir = path.join(agentDir, "sessions");
  const sessionA = path.join(sessionDir, "a.jsonl");
  const sessionB = path.join(sessionDir, "b.jsonl");
  const entered = path.join(dir, `${phase}.entered`);
  const release = path.join(dir, `${phase}.release`);
  const continued = path.join(dir, `${phase}.continued`);
  const traceDir = path.join(dir, "trace");
  const timelinePath = path.join(dir, `${phase}.timeline.json`);
  const runId = randomUUID();
  const traceKey = `${TRACE_KEY_PREFIX}:${runId}`;
  const runIdHash = traceRunIdHash(runId, traceKey);
  await Promise.all([agentDir, workspaceA, workspaceB, sessionDir].map((entry) => fs.mkdir(entry, { recursive: true })));
  const fixturePath = repoPath("extension", "test", "fixtures", "blocking-liveness-extension.ts");
  assert.ok(providerPort > 0, "provider port must be supplied by the harness");
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "phase-0-provider",
    defaultModel: "phase-0-model",
    defaultThinkingLevel: "off",
    defaultProjectTrust: "always",
    extensions: [fixturePath],
  }, null, 2));
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "phase-0-provider": {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: "openai-completions",
        models: [{
          id: "phase-0-model", name: "Phase 0 local model", reasoning: false, input: ["text"],
          contextWindow: 8192, maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2));
  await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n");
  const header = (cwd: string, id: string) => JSON.stringify({ type: "session", id, version: 3, cwd });
  await fs.writeFile(sessionA, `${header(workspaceA, "phase-0-a")}\n`);
  await fs.writeFile(sessionB, `${header(workspaceB, "phase-0-b")}\n`);
  return { agentDir, workspaceA, workspaceB, sessionA, sessionB, entered, release, continued, traceDir, timelinePath, runId, traceKey, runIdHash };
}

/**
 * Build into the scenario's temporary directory rather than trusting the
 * ignored extension/out directory. This makes an env-enabled run own the
 * exact artifact it executes and keeps the normal skipped path build-free.
 */
async function buildTestOwnedBackendArtifact(dir: string): Promise<string> {
  const artifactDir = path.join(dir, "backend-artifact");
  const viteCli = repoPath("extension", "node_modules", "vite", "bin", "vite.js");
  if (!(await exists(viteCli))) {
    throw new Error(
      `Phase 0 liveness needs the local Vite build tool at ${viteCli}. ` +
      "Run npm ci, then npm run extension:build before retrying the env-enabled characterization.",
    );
  }
  const result = spawnSync(process.execPath, [viteCli, "build", "--mode", "node", "--outDir", artifactDir, "--emptyOutDir"], {
    cwd: repoPath("extension"),
    encoding: "utf8",
    timeout: STARTUP_DEADLINE_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const diagnostics = `${typeof result.stdout === "string" ? result.stdout : ""}${typeof result.stderr === "string" ? result.stderr : ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(
      `Phase 0 liveness could not build its test-owned backend artifact. ` +
      "Run npm run extension:build and retry the env-enabled characterization." +
      (diagnostics ? `\n${diagnostics.slice(-4_000)}` : ""),
    );
  }
  const backendPath = path.join(artifactDir, "backend.js");
  if (!(await exists(backendPath))) {
    throw new Error(
      `Phase 0 liveness build completed without ${backendPath}. ` +
      "Run npm run extension:build and retry the env-enabled characterization.",
    );
  }
  return backendPath;
}

function startBackend(
  dir: string,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  phase: Scenario,
  backendPath: string,
): BackendHarness {
  const sdkPath = repoPath("extension", "node_modules", "@earendil-works", "pi-coding-agent");
  assert.ok(path.isAbsolute(backendPath));
  const child = spawn(process.execPath, [backendPath, "--sdkPath", sdkPath, "--cwd", fixture.workspaceA], {
    cwd: fixture.workspaceA,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: fixture.agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(fixture.agentDir, "sessions"),
      PIE_BLOCKING_LIVENESS_PHASE: phase,
      PIE_BLOCKING_LIVENESS_RUN_ID: fixture.runId,
      PIE_BLOCKING_LIVENESS_ENTERED: fixture.entered,
      PIE_BLOCKING_LIVENESS_RELEASE: fixture.release,
      PIE_BLOCKING_LIVENESS_CONTINUED: fixture.continued,
      PIE_BLOCKING_LIVENESS_TARGET_CWD: fixture.workspaceA,
      PIE_BLOCKING_LIVENESS_DEADLINE_MS: String(MARKER_DEADLINE_MS * 4),
      // The backend trace is metadata-only and is merged into the harness-owned timeline.
      PI_DIAG: "1",
      PIE_LIVE_PIPELINE_TRACE_DIR: fixture.traceDir,
      PIE_LIVE_PIPELINE_TRACE_RUN_ID: fixture.runId,
      PIE_LIVE_PIPELINE_TRACE_KEY: fixture.traceKey,
      PIE_PROVIDER_TRAFFIC_LOG: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  assert.ok(child.stdin && child.stdout && child.stderr);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-32 * 1024);
  });
  const responses = new Map<string, (response: RpcResponse) => void>();
  const events = new Map<string, Array<(payload: unknown) => void>>();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let envelope: RpcResponse & { event?: string; payload?: unknown };
    try { envelope = JSON.parse(line) as typeof envelope; } catch { return; }
    if (typeof envelope.id === "string") responses.get(envelope.id)?.(envelope);
    if (typeof envelope.event === "string") {
      const waiters = events.get(envelope.event) ?? [];
      events.delete(envelope.event);
      for (const waiter of waiters) waiter(envelope.payload);
    }
  });
  const waitFor = <T>(operation: Promise<T>, label: string, timeoutMs = CONTROL_RESPONSE_DEADLINE_MS): Promise<T> => new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs}ms\nstderr: ${stderr}`)), timeoutMs);
    timeout.unref?.();
    operation.then(resolve, (error) => reject(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}\nstderr: ${stderr}`)))
      .finally(() => clearTimeout(timeout));
  });
  let requestId = 0;
  return {
    child,
    get stderr() { return stderr; },
    request(method, params, timeoutMs = CONTROL_RESPONSE_DEADLINE_MS, onReceipt) {
      const id = `phase-0-${++requestId}`;
      return waitFor(new Promise<RpcResponse>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          // Keep the response listener after the bounded waiter expires. A
          // legacy coordinator can finally write this response after release;
          // the harness must record that receipt rather than erase evidence.
          settled = true;
          reject(new Error(`timed out waiting for ${method} response`));
        }, timeoutMs);
        timer.unref?.();
        responses.set(id, (response) => {
          clearTimeout(timer);
          responses.delete(id);
          onReceipt?.(response);
          if (!settled) {
            settled = true;
            resolve(response);
          }
        });
        child.stdin!.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
      }), method, timeoutMs);
    },
    waitForEvent(event, timeoutMs = CONTROL_RESPONSE_DEADLINE_MS) {
      return waitFor(new Promise<unknown>((resolve) => {
        const waiters = events.get(event) ?? [];
        waiters.push(resolve);
        events.set(event, waiters);
      }), event, timeoutMs);
    },
    async close(onCaptured) {
      // Capture the complete ancestry before sending EOF or a signal. Waiting
      // for natural exit first loses reparented descendants and makes cleanup
      // unable to prove which identities it owned.
      assert.ok(Number.isInteger(child.pid), "spawned backend must have a process identity");
      const capture: ProcessCapture = {
        captured: snapshotProcessTree(child.pid),
        rootAliveAtCapture: child.exitCode === null && child.signalCode === null,
      };
      onCaptured?.(capture);
      const cleanup = await terminateProcessTree(child);
      try { child.stdin?.destroy(); } catch { /* already closed */ }
      responses.clear();
      lines.close();
      return { ...cleanup, captured: capture.captured, rootAliveAtCapture: capture.rootAliveAtCapture };
    },
  };
}

async function readBackendTrace(traceDir: string, expectedRunIdHash: string): Promise<LivePipelineTraceRecord[]> {
  const names = await fs.readdir(traceDir).catch(() => [] as string[]);
  const records: LivePipelineTraceRecord[] = [];
  for (const name of names.filter((entry) => entry.startsWith("live-pipeline-backend") && entry.endsWith(".jsonl")).sort()) {
    const data = await fs.readFile(path.join(traceDir, name), "utf8").catch(() => "");
    for (const line of data.split(/\r?\n/u).filter(Boolean)) {
      const record = JSON.parse(line) as LivePipelineTraceRecord;
      assert.equal(record.runIdHash, expectedRunIdHash, "backend trace record must use this scenario's stable run identity");
      records.push(record);
    }
  }
  records.sort((left, right) => (left.processSeq ?? Number.MAX_SAFE_INTEGER) - (right.processSeq ?? Number.MAX_SAFE_INTEGER));
  return records;
}

async function waitForStableBackendTrace(traceDir: string, expectedRunIdHash: string): Promise<LivePipelineTraceRecord[]> {
  const deadline = Date.now() + TRACE_STABILITY_DEADLINE_MS;
  let records: LivePipelineTraceRecord[] = [];
  let previousCount = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    records = await readBackendTrace(traceDir, expectedRunIdHash);
    if (records.length > 0 && records.length === previousCount) stableReads += 1;
    else stableReads = 0;
    previousCount = records.length;
    if (stableReads >= 2) return records;
    await sleep(50);
  }
  return records;
}

function readFixtureMarker(filePath: string): { phase: Scenario; runId: string; pid: number; reason: string; wallMs: number } {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  assert.equal(typeof value.phase, "string");
  assert.equal(typeof value.runId, "string");
  assert.equal(typeof value.pid, "number");
  assert.equal(typeof value.reason, "string");
  const wallMs = value.enteredAt ?? value.continuedAt;
  assert.equal(typeof wallMs, "number", "fixture marker must carry a Date.now wall-clock timestamp");
  assert.ok(Number.isSafeInteger(wallMs), "fixture marker wall-clock timestamp must be a safe integer");
  return { phase: value.phase as Scenario, runId: value.runId as string, pid: value.pid as number, reason: value.reason as string, wallMs: wallMs as number };
}

interface StallExpectation {
  reason: string;
  traceStage: "backend.subagent" | "backend.runtime";
  tracePhase: BlockingTracePhase;
}

function expectedStallExpectation(scenario: Scenario): StallExpectation {
  return scenario === "execution-hook"
    ? { reason: "before-agent-start", traceStage: "backend.subagent", tracePhase: "extension_hook" }
    : { reason: "extension-factory-resource-bootstrap", traceStage: "backend.runtime", tracePhase: "service_loading" };
}

function expectedEnteredReason(scenario: Scenario): string {
  return expectedStallExpectation(scenario).reason;
}

function writerEntryMatches(left: LivePipelineTraceRecord, right: LivePipelineTraceRecord): boolean {
  if (left.writerSeq !== undefined && right.writerSeq !== undefined) return left.writerSeq === right.writerSeq;
  return left.writerLane === right.writerLane
    && left.eventKind === right.eventKind
    && left.eventSeq === right.eventSeq
    && left.requestHash === right.requestHash
    && left.producedPayloadBytes === right.producedPayloadBytes;
}

interface ExplicitWriterMetadata {
  activeWriteSeq?: number;
  activeWriteLane?: string;
  aheadOfResponse?: boolean;
  queuedBehindResponse?: boolean;
}

/**
 * Consume only the writer's explicit queue/active-write metadata. queueDepth
 * and arbitrary pending records do not establish queue ownership: a queued
 * record may have been emitted after the OS write settled, and trace flushes
 * are independent of stream order.
 */
function explicitWriterMetadata(record: LivePipelineTraceRecord): ExplicitWriterMetadata | undefined {
  const candidate = record as LivePipelineTraceRecord & {
    activeWriteSeq?: unknown;
    activeWriteLane?: unknown;
    aheadOfResponse?: unknown;
    queuedBehindResponse?: unknown;
  };
  const activeWriteSeq = typeof candidate.activeWriteSeq === "number"
    && Number.isSafeInteger(candidate.activeWriteSeq) && candidate.activeWriteSeq >= 0
    ? candidate.activeWriteSeq
    : undefined;
  const activeWriteLane = typeof candidate.activeWriteLane === "string" ? candidate.activeWriteLane : undefined;
  const aheadOfResponse = typeof candidate.aheadOfResponse === "boolean" ? candidate.aheadOfResponse : undefined;
  const queuedBehindResponse = typeof candidate.queuedBehindResponse === "boolean" ? candidate.queuedBehindResponse : undefined;
  if (activeWriteSeq === undefined && activeWriteLane === undefined && aheadOfResponse === undefined && queuedBehindResponse === undefined) return undefined;
  return {
    ...(activeWriteSeq === undefined ? {} : { activeWriteSeq }),
    ...(activeWriteLane === undefined ? {} : { activeWriteLane }),
    ...(aheadOfResponse === undefined ? {} : { aheadOfResponse }),
    ...(queuedBehindResponse === undefined ? {} : { queuedBehindResponse }),
  };
}

function summarizeWriterEvidence(backendRecords: LivePipelineTraceRecord[]): WriterEvidence {
  const writerRecords = backendRecords.filter((record) => record.stage === "backend.writer.queued" || record.stage === "backend.writer.settled");
  const responseQueued = writerRecords.filter((record) => record.stage === "backend.writer.queued" && record.writerLane === "response");
  if (responseQueued.length === 0) {
    return {
      status: "unavailable",
      basis: "unavailable-no-explicit-active-write-ahead-metadata",
      queuedBehind: {},
      reason: "No response-lane writer queue record was emitted by the backend trace.",
    };
  }

  let anotherResponse = 0;
  let event = 0;
  let activeOsWrite = 0;
  let explicitCount = 0;
  let maxObservedQueueDepth = 0;
  const observedLanes = new Set<string>();
  for (const record of writerRecords) {
    if (record.writerLane) observedLanes.add(record.writerLane);
    if (record.queueDepth !== undefined) maxObservedQueueDepth = Math.max(maxObservedQueueDepth, record.queueDepth);
  }
  for (const record of responseQueued) {
    // The queue record describes the active write and response lane at the
    // only useful point: enqueue. A matching settlement is used only for its
    // explicit aheadOfResponse fallback, never to infer state from pending
    // rows. writerSeq makes that pairing exact when the field is present.
    const queuedMetadata = explicitWriterMetadata(record);
    const settlement = writerRecords.find((candidate) => candidate.stage === "backend.writer.settled" && writerEntryMatches(record, candidate));
    const settlementMetadata = settlement ? explicitWriterMetadata(settlement) : undefined;
    const metadata = queuedMetadata ?? settlementMetadata;
    if (!metadata) continue;
    explicitCount += 1;
    if (metadata.queuedBehindResponse === true
      || (queuedMetadata === undefined && settlementMetadata?.aheadOfResponse === true)) anotherResponse += 1;
    if (queuedMetadata?.activeWriteSeq !== undefined) {
      activeOsWrite += 1;
      if (queuedMetadata.activeWriteLane !== undefined && queuedMetadata.activeWriteLane !== "response") event += 1;
    }
  }
  const basis: WriterEvidenceBasis = explicitCount === responseQueued.length
    ? "explicit-active-write-ahead-metadata"
    : explicitCount > 0
      ? "partial-explicit-active-write-ahead-metadata"
      : "unavailable-no-explicit-active-write-ahead-metadata";
  return {
    status: explicitCount > 0 ? "observed" : "unavailable",
    basis,
    responseWriteCount: responseQueued.length,
    queuedBehind: explicitCount > 0 ? { anotherResponse, event, activeOsWrite } : {},
    maxObservedQueueDepth,
    observedLanes: [...observedLanes].sort(),
    ...(explicitCount === 0 ? {
      reason: "The backend trace emitted response queue records but no explicit active-write/ahead metadata; queuedBehind fields were not inferred from pending records.",
    } : explicitCount < responseQueued.length ? {
      reason: "Only some response queue records carried explicit active-write/ahead metadata; missing entries remain unavailable.",
    } : {}),
  };
}

function summarizePayloadBytes(
  backendRecords: LivePipelineTraceRecord[],
  payloadClass: string,
  subagentActivity: boolean,
): PayloadByteMetric {
  if (!subagentActivity) {
    return { status: "unavailable", reason: NO_SUBAGENT_ACTIVITY_REASON };
  }
  const matching = backendRecords.filter((record) => record.payloadClass === payloadClass);
  if (matching.length === 0) {
    return {
      status: "unavailable",
      reason: payloadClass.startsWith("detail_")
        ? "detail_delivery_not_implemented_until_phase_5"
        : `No backend trace record declared payloadClass=${payloadClass}; this metric was not inferred from a phase name.`,
    };
  }
  const hasBytes = matching.some((record) => record.sourcePayloadBytes !== undefined || record.producedPayloadBytes !== undefined);
  if (!hasBytes) {
    return {
      status: "unavailable",
      recordCount: matching.length,
      reason: matching.find((record) => record.availabilityReason !== undefined)?.availabilityReason
        ?? `Backend trace records declared payloadClass=${payloadClass} but carried no byte counter.`,
    };
  }
  const sourcePayloadBytes = matching.reduce((total, record) => total + (record.sourcePayloadBytes ?? 0), 0);
  const producedPayloadBytes = matching.reduce((total, record) => total + (record.producedPayloadBytes ?? 0), 0);
  return {
    status: "observed",
    recordCount: matching.length,
    ...(sourcePayloadBytes === 0 ? {} : { sourcePayloadBytes }),
    ...(producedPayloadBytes === 0 ? {} : { producedPayloadBytes }),
  };
}

function isSubagentActivityRecord(record: LivePipelineTraceRecord): boolean {
  // The execution-hook fixture also uses the shared runtime sink for its
  // blocking span. It has no subagent correlation, payload class, or semantic
  // outcome, so a stage name alone is not evidence that a subagent ran.
  return record.stage === "backend.subagent"
    && (record.payloadClass !== undefined || record.outcome !== undefined || record.toolHash !== undefined);
}

/**
 * One canonical record per accumulator diff observation. Each `observe()`
 * call on the backend accumulator emits exactly one diff record (changed or
 * duplicate), and the trace store stamps every persisted record with its own
 * process-local monotonic processSeq, so that sequence is the closed
 * source-observation identity. A changed record at revision N and a later
 * duplicate re-observation of revision N are two distinct observations and
 * both count; records sharing correlation/revision are never collapsed.
 * Runner/settlement duplicate instrumentation (the closed "dedupe" phase
 * emitted by runner.ts and the execute-boundary settlement observer) is
 * excluded explicitly: it never carries the diff phase plus the
 * observation-identifying revision/toolHash/outcome fields required here.
 */
function canonicalSubagentBoundaryRecords(backendRecords: LivePipelineTraceRecord[]): LivePipelineTraceRecord[] {
  const seen = new Set<number>();
  const canonical: LivePipelineTraceRecord[] = [];
  for (const record of backendRecords) {
    if (record.stage !== "backend.subagent") continue;
    // Rejected observations never contribute an outcome to this count.
    if (record.phase !== "diff" || record.outcome === undefined || record.kind === "rejected") continue;
    if (record.revision === undefined || record.toolHash === undefined) continue;
    if (record.processSeq === undefined || seen.has(record.processSeq)) continue;
    seen.add(record.processSeq);
    canonical.push(record);
  }
  return canonical;
}

function summarizeSemanticChanges(backendRecords: LivePipelineTraceRecord[]): {
  sourceUpdateCount: number;
  semanticChanges: number;
  duplicates: number;
} {
  const canonical = canonicalSubagentBoundaryRecords(backendRecords);
  return {
    sourceUpdateCount: canonical.length,
    semanticChanges: canonical.filter((record) => record.outcome === "changed").length,
    duplicates: canonical.filter((record) => record.outcome === "duplicate").length,
  };
}

function deriveOverlappingTracePhaseSpans(
  backendRecords: LivePipelineTraceRecord[],
  enteredAtMs: number,
  continuedAtMs: number,
): StallTracePhaseSpan[] {
  const spans: StallTracePhaseSpan[] = [];
  for (const record of backendRecords) {
    if (!record.phase || record.durationMs === undefined || !Number.isFinite(record.durationMs) || record.durationMs < 0) continue;
    const endMs = Date.parse(record.ts);
    if (!Number.isFinite(endMs)) continue;
    const startMs = endMs - record.durationMs;
    const overlapStartMs = Math.max(startMs, enteredAtMs);
    const overlapEndMs = Math.min(endMs, continuedAtMs);
    // Trace monoMs is process-local and deliberately not compared here. The
    // persisted ISO timestamp plus duration is the robust cross-process wall
    // clock span used by this artifact.
    if (overlapStartMs > overlapEndMs) continue;
    spans.push({
      process: record.process,
      ...(record.pid === undefined ? {} : { pid: record.pid }),
      ...(record.processSeq === undefined ? {} : { processSeq: record.processSeq }),
      stage: record.stage,
      phase: record.phase,
      kind: record.kind,
      startMs,
      endMs,
      overlapStartMs,
      overlapEndMs,
      overlapMs: overlapEndMs - overlapStartMs,
    });
  }
  return spans.sort((left, right) => left.overlapStartMs - right.overlapStartMs || left.endMs - right.endMs || (left.processSeq ?? 0) - (right.processSeq ?? 0));
}

function deriveEvidence(
  scenario: Scenario,
  events: HarnessTimelineEvent[],
  backendRecords: LivePipelineTraceRecord[],
): LivenessEvidence {
  const expectation = expectedStallExpectation(scenario);
  const entered = events.find((event) => event.marker === "phase.entered");
  const release = events.find((event) => event.marker === "release.created");
  const continued = events.find((event) => event.marker === "phase.continued");
  assert.ok(entered && release && continued, "timeline must contain the complete externally controlled block window");
  assert.ok(entered.seq < release.seq && release.seq < continued.seq, "release must be created after entry and before continuation");
  assert.equal(entered.phase, scenario, "entered marker must identify this scenario");
  assert.equal(continued.phase, scenario, "continued marker must identify this scenario");
  assert.equal(entered.reason, expectation.reason, "stall ownership must use the exact scenario-specific fixture reason");
  assert.equal(continued.reason, expectation.reason, "continued marker must retain the exact scenario-specific fixture reason");
  const enteredPid = entered.pid;
  if (typeof enteredPid !== "number" || !Number.isSafeInteger(enteredPid) || enteredPid <= 0) throw new Error("entered marker must identify a positive blocking PID");
  const blockingPid = enteredPid;
  assert.ok(Number.isSafeInteger(entered.wallMs) && Number.isSafeInteger(release.wallMs) && Number.isSafeInteger(continued.wallMs), "block markers must carry wall-clock timestamps");
  assert.ok(entered.wallMs < release.wallMs, "release must be created after the entered epoch timestamp");
  assert.ok(release.wallMs <= continued.wallMs, "continued marker must follow the release epoch timestamp");
  assert.equal(continued.pid, blockingPid, "entered and continued markers must identify the same blocking process");
  const blockingSpanStartMs = entered.wallMs;
  const blockingSpanEndMs = continued.wallMs;
  const unreleasedStartMs = entered.wallMs;
  const unreleasedEndMs = release.wallMs;
  const overlapStartMs = Math.max(blockingSpanStartMs, unreleasedStartMs);
  const overlapEndMs = Math.min(blockingSpanEndMs, unreleasedEndMs);
  const blockingSpan: BlockingSpanEvidence = {
    scenario,
    markerPhase: scenario,
    reason: expectation.reason,
    traceStage: expectation.traceStage,
    tracePhase: expectation.tracePhase,
    pid: blockingPid,
    startMs: blockingSpanStartMs,
    endMs: blockingSpanEndMs,
    unreleasedStartMs,
    unreleasedEndMs,
    overlapStartMs,
    overlapEndMs,
    overlapMs: overlapEndMs - overlapStartMs,
    clockBasis: CLOCK_BASIS,
  };
  assert.ok(blockingSpan.overlapMs > 0, "blocking span must positively overlap the unreleased interval");

  // Keep every overlapping backend span as supporting evidence, but select the
  // required scenario span by its closed stage/phase and blocking PID. A broad
  // handler_finished or a record emitted after release is never sufficient.
  const phaseSpans = deriveOverlappingTracePhaseSpans(backendRecords, entered.wallMs, continued.wallMs);
  const requiredPhaseSpan = phaseSpans.find((span) =>
    span.process === "backend"
    && span.pid === blockingPid
    && span.stage === expectation.traceStage
    && span.phase === expectation.tracePhase
    && span.endMs > span.startMs
    && Math.min(span.endMs, blockingSpan.unreleasedEndMs) > Math.max(span.startMs, blockingSpan.unreleasedStartMs),
  );
  assert.ok(requiredPhaseSpan, `timeline must contain the exact ${expectation.tracePhase} span for the blocking PID with positive unreleased overlap`);
  const responses = events.filter((event): event is HarnessTimelineEvent & { method: ControlMethod } => event.marker === "control.response.received" && event.method !== undefined);
  const before = responses.filter((event) => event.seq < release.seq && event.releasePresent === false).map((event) => event.method);
  const after = responses.filter((event) => event.seq > release.seq || event.releasePresent === true).map((event) => event.method);
  const backendTracePhases = [...new Set(phaseSpans.map((span) => span.phase))].sort();
  const subagentActivity = backendRecords.some(isSubagentActivityRecord);
  const semanticActivity = summarizeSemanticChanges(backendRecords);
  return {
    clockBasis: CLOCK_BASIS,
    blockedWindow: {
      enteredSeq: entered.seq,
      releaseSeq: release.seq,
      continuedSeq: continued.seq,
      enteredAtMs: entered.wallMs,
      continuedAtMs: continued.wallMs,
    },
    expectedControlMethods: CONTROL_METHODS,
    responseMethodsBeforeRelease: before,
    responseMethodsAfterRelease: after,
    coordinatorResponsiveWhileABlocked: new Set(before).size === CONTROL_METHODS.length,
    coordinatorResponsiveness: {
      status: "observed",
      answer: new Set(before).size === CONTROL_METHODS.length,
      basis: "control-response-receipts-before-release",
    },
    synchronousStall: {
      status: "observed",
      owner: expectation.reason,
      blockingSpan,
      backendTracePhases,
      phaseSpans,
      requiredPhaseSpan,
      phaseSpanStatus: "observed",
      basis: "scenario-entered-reason-and-overlapping-trace-spans",
      clockBasis: CLOCK_BASIS,
    },
    writer: summarizeWriterEvidence(backendRecords),
    recursiveBytes: {
      sourceUpdate: summarizePayloadBytes(backendRecords, "source", subagentActivity),
      compactEvent: summarizePayloadBytes(
        canonicalSubagentBoundaryRecords(backendRecords), "compact", subagentActivity,
      ),
      detailBaseline: summarizePayloadBytes(backendRecords, "detail_baseline", subagentActivity),
      detailPage: summarizePayloadBytes(backendRecords, "detail_page", subagentActivity),
      detailDelta: summarizePayloadBytes(backendRecords, "detail_delta", subagentActivity),
      detailTerminal: summarizePayloadBytes(backendRecords, "detail_terminal", subagentActivity),
      terminalTransport: summarizePayloadBytes(backendRecords, "terminal_transport", subagentActivity),
      terminalAppend: summarizePayloadBytes(backendRecords, "terminal_append", subagentActivity),
    },
    sourceUpdateCount: semanticActivity.sourceUpdateCount,
    semanticChanges: semanticActivity.semanticChanges,
    duplicates: semanticActivity.duplicates,
    backendTraceRecordCount: backendRecords.length,
    backendTraceStages: [...new Set(backendRecords.map((record) => record.stage))].sort(),
    backendTracePhases,
  };
}

function buildTimelineArtifact(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  scenario: Scenario,
  events: HarnessTimelineEvent[],
  backendRecords: LivePipelineTraceRecord[],
): LivenessTimelineArtifact {
  const linkedBackend = backendRecords.map((record): BackendTimelineRecord => ({ source: "backend", record }));
  const records = [...events, ...linkedBackend].sort((left, right) => {
    const leftTs = left.source === "harness" ? left.ts : left.record.ts;
    const rightTs = right.source === "harness" ? right.ts : right.record.ts;
    return Date.parse(leftTs) - Date.parse(rightTs);
  });
  return {
    schemaVersion: 1,
    kind: "phase-0-liveness-timeline",
    runId: fixture.runId,
    runIdHash: fixture.runIdHash,
    scenario,
    generatedAt: new Date().toISOString(),
    records,
    evidence: deriveEvidence(scenario, events, backendRecords),
  };
}

function assertMetadataOnly(value: unknown): void {
  const forbidden = new Set(["prompt", "reasoning", "content", "input", "inputs", "params", "payload", "result", "error", "stdout", "stderr", "toolInput", "toolResult"]);
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    for (const [key, nested] of Object.entries(entry)) {
      assert.equal(forbidden.has(key), false, `timeline contains non-metadata field ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

function validateTimelineArtifact(value: unknown, fixture: Awaited<ReturnType<typeof createFixture>>, scenario: Scenario): asserts value is LivenessTimelineArtifact {
  assert.ok(value && typeof value === "object");
  const artifact = value as Partial<LivenessTimelineArtifact>;
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.kind, "phase-0-liveness-timeline");
  assert.equal(artifact.runId, fixture.runId);
  assert.equal(artifact.runIdHash, fixture.runIdHash);
  assert.equal(artifact.scenario, scenario);
  assert.ok(Array.isArray(artifact.records));
  assert.ok(artifact.evidence && typeof artifact.evidence === "object");
  const harnessEvents = artifact.records.filter((record): record is HarnessTimelineEvent => record.source === "harness");
  assert.deepEqual(harnessEvents.map((event) => event.seq), [...Array(harnessEvents.length).keys()]);
  assert.ok(harnessEvents.every((event) => event.runId === fixture.runId && event.scenario === scenario));
  for (const marker of ["process.spawned", "process.ready", "phase.entered", "release.created", "phase.continued", "cleanup.started", "cleanup.completed"] as const) {
    assert.ok(harnessEvents.some((event) => event.marker === marker), `timeline is missing ${marker}`);
  }
  const entered = harnessEvents.find((event) => event.marker === "phase.entered");
  const release = harnessEvents.find((event) => event.marker === "release.created");
  const continued = harnessEvents.find((event) => event.marker === "phase.continued");
  const cleanupStarted = harnessEvents.find((event) => event.marker === "cleanup.started");
  const cleanupCompleted = harnessEvents.find((event) => event.marker === "cleanup.completed");
  const expectation = expectedStallExpectation(scenario);
  assert.ok(entered?.reason, "timeline must retain the fixture's synchronous phase owner");
  assert.equal(entered.reason, expectation.reason, "artifact must retain the exact scenario-specific entered reason");
  assert.equal(entered.phase, scenario, "artifact must retain the exact scenario marker phase");
  assert.ok(release, "timeline must retain the release marker");
  assert.ok(continued, "timeline must retain the fixture's continued marker");
  assert.equal(continued.reason, expectation.reason, "artifact must retain the exact scenario-specific continued reason");
  assert.equal(continued.phase, scenario, "artifact must retain the exact continued marker phase");
  assert.equal(continued.pid, entered.pid, "artifact markers must retain the blocking process identity");
  assert.ok(Number.isSafeInteger(entered.wallMs) && Number.isSafeInteger(release.wallMs) && Number.isSafeInteger(continued.wallMs), "artifact markers must retain wall-clock timestamps");
  const receipts = harnessEvents.filter((event): event is HarnessTimelineEvent & { method: ControlMethod; releasePresent: boolean } => event.marker === "control.response.received" && event.method !== undefined && typeof event.releasePresent === "boolean");
  assert.equal(receipts.length, CONTROL_METHODS.length, "timeline must record every control response receipt");
  assert.deepEqual(new Set(receipts.map((event) => event.method)), new Set(CONTROL_METHODS));
  assert.equal(cleanupStarted?.rootAliveAtCapture, true, "timeline must capture ancestry while root identity is intact");
  assert.equal(cleanupCompleted?.identityVerification, "gone", "timeline must record verified process-tree extinction");
  assert.equal(cleanupCompleted?.survivorPidCount, 0, "timeline must record no process-tree survivors");
  assert.ok((cleanupStarted?.capturedProcesses?.length ?? 0) > 0, "timeline must retain captured process ancestry");
  const backendRecords = artifact.records.filter((record): record is BackendTimelineRecord => record.source === "backend").map((record) => record.record);
  assert.equal(backendRecords.length, artifact.evidence.backendTraceRecordCount);
  assert.ok(backendRecords.length > 0, "timeline must link at least one backend metadata record");
  assert.ok(backendRecords.every((record) => record.runIdHash === fixture.runIdHash));
  assert.ok(backendRecords.some((record) => record.stage === "backend.request"), "timeline must link request-phase records");
  assert.ok(backendRecords.some((record) => record.stage === "backend.runtime"), "timeline must link synchronous runtime-phase records");
  assert.ok(backendRecords.some((record) => record.stage === "backend.writer.queued"), "timeline must link response-writer queue records");
  assert.ok(backendRecords.some((record) => record.stage === "backend.writer.settled"), "timeline must link response-writer settlement records");

  const evidence = artifact.evidence;
  assert.equal(evidence.clockBasis, CLOCK_BASIS, "artifact must state the comparable cross-process clock basis");
  assert.deepEqual(evidence.blockedWindow, {
    enteredSeq: entered.seq,
    releaseSeq: release.seq,
    continuedSeq: continued.seq,
    enteredAtMs: entered.wallMs,
    continuedAtMs: continued.wallMs,
  });
  assert.equal(evidence.coordinatorResponsiveness.status, "observed");
  assert.equal(typeof evidence.coordinatorResponsiveness.answer, "boolean");
  assert.equal(evidence.coordinatorResponsiveWhileABlocked, evidence.coordinatorResponsiveness.answer);
  if (evidence.coordinatorResponsiveness.answer) {
    assert.deepEqual(new Set(evidence.responseMethodsBeforeRelease), new Set(CONTROL_METHODS));
  }
  assert.equal(evidence.synchronousStall.owner, expectation.reason);
  assert.equal(evidence.synchronousStall.basis, "scenario-entered-reason-and-overlapping-trace-spans");
  assert.equal(evidence.synchronousStall.clockBasis, CLOCK_BASIS);
  assert.equal(evidence.synchronousStall.phaseSpanStatus, "observed", "the exact scenario phase span is required evidence");
  const blockingSpan = evidence.synchronousStall.blockingSpan;
  assert.equal(blockingSpan.scenario, scenario);
  assert.equal(blockingSpan.markerPhase, scenario);
  assert.equal(blockingSpan.reason, expectation.reason);
  assert.equal(blockingSpan.traceStage, expectation.traceStage);
  assert.equal(blockingSpan.tracePhase, expectation.tracePhase);
  assert.equal(blockingSpan.pid, entered.pid);
  assert.equal(blockingSpan.startMs, entered.wallMs);
  assert.equal(blockingSpan.endMs, continued.wallMs);
  assert.equal(blockingSpan.unreleasedStartMs, entered.wallMs);
  assert.equal(blockingSpan.unreleasedEndMs, release.wallMs);
  assert.ok(blockingSpan.startMs < blockingSpan.endMs);
  assert.ok(blockingSpan.unreleasedStartMs < blockingSpan.unreleasedEndMs);
  assert.ok(blockingSpan.overlapMs > 0, "the generated blocking span must overlap the unreleased interval");
  assert.equal(blockingSpan.overlapMs, blockingSpan.overlapEndMs - blockingSpan.overlapStartMs);

  const requiredPhaseSpan = evidence.synchronousStall.requiredPhaseSpan;
  assert.equal(requiredPhaseSpan.process, "backend");
  assert.equal(requiredPhaseSpan.pid, blockingSpan.pid, "required trace evidence must belong to the blocking process");
  assert.equal(requiredPhaseSpan.stage, expectation.traceStage, "generic request records cannot satisfy the scenario span");
  assert.equal(requiredPhaseSpan.phase, expectation.tracePhase, "the exact scenario phase is required");
  assert.ok(requiredPhaseSpan.endMs > requiredPhaseSpan.startMs, "required trace span must have a positive duration");
  const requiredOverlapStartMs = Math.max(requiredPhaseSpan.startMs, blockingSpan.unreleasedStartMs);
  const requiredOverlapEndMs = Math.min(requiredPhaseSpan.endMs, blockingSpan.unreleasedEndMs);
  assert.ok(requiredOverlapEndMs > requiredOverlapStartMs, "required trace span must positively overlap the unreleased interval");
  for (const span of evidence.synchronousStall.phaseSpans) {
    assert.ok(span.overlapStartMs <= span.overlapEndMs);
    assert.ok(span.overlapStartMs >= entered.wallMs);
    assert.ok(span.overlapEndMs <= continued.wallMs);
    assert.equal(span.overlapMs, span.overlapEndMs - span.overlapStartMs);
  }
  assert.ok(evidence.synchronousStall.phaseSpans.some((span) =>
    span.process === requiredPhaseSpan.process
    && span.pid === requiredPhaseSpan.pid
    && span.stage === requiredPhaseSpan.stage
    && span.phase === requiredPhaseSpan.phase
    && span.startMs === requiredPhaseSpan.startMs
    && span.endMs === requiredPhaseSpan.endMs,
  ));
  assert.deepEqual(evidence.synchronousStall.backendTracePhases, [...new Set(evidence.synchronousStall.phaseSpans.map((span) => span.phase))].sort());
  assert.ok(evidence.writer);
  assert.ok(evidence.writer.basis);
  if (evidence.writer.status === "observed") assert.ok(Number.isSafeInteger(evidence.writer.responseWriteCount));
  if (evidence.writer.basis === "unavailable-no-explicit-active-write-ahead-metadata") assert.ok(evidence.writer.reason);
  for (const metric of Object.values(evidence.recursiveBytes)) {
    assert.ok(metric && (metric.status === "observed" || metric.status === "unavailable"));
    if (metric.status === "unavailable") assert.ok(metric.reason, "unavailable detail metrics must explain the missing producer evidence");
  }
  const subagentRecords = backendRecords.filter(isSubagentActivityRecord);
  assert.ok(Number.isSafeInteger(evidence.sourceUpdateCount));
  assert.ok(Number.isSafeInteger(evidence.semanticChanges));
  assert.ok(Number.isSafeInteger(evidence.duplicates));
  if (subagentRecords.length === 0) {
    // These scenarios deliberately stop before any subagent tool executes.
    // Missing telemetry must not be silently interpreted as an unknown amount
    // of work or as an arbitrary zero: the closed reason is part of the answer.
    assert.equal(evidence.sourceUpdateCount, 0);
    assert.equal(evidence.semanticChanges, 0);
    assert.equal(evidence.duplicates, 0);
    for (const metric of Object.values(evidence.recursiveBytes)) {
      if (metric.status === "unavailable") assert.equal(metric.reason, NO_SUBAGENT_ACTIVITY_REASON);
      else {
        assert.equal(metric.sourcePayloadBytes ?? 0, 0);
        assert.equal(metric.producedPayloadBytes ?? 0, 0);
      }
    }
  } else {
    const canonical = canonicalSubagentBoundaryRecords(backendRecords);
    assert.equal(evidence.sourceUpdateCount, canonical.length, "one diff observation is counted once");
    assert.equal(evidence.semanticChanges, canonical.filter((record) => record.outcome === "changed").length);
    assert.equal(evidence.duplicates, canonical.filter((record) => record.outcome === "duplicate").length);
  }
  // Recompute evidence from the persisted records. This rejects a schema-only
  // artifact whose summary disagrees with the actual entered/receipt/trace
  // timeline and keeps unavailable future detail metrics explicit.
  assert.deepEqual(artifact.evidence, deriveEvidence(scenario, harnessEvents, backendRecords));
  assertMetadataOnly(value);
}

test("Phase 0 liveness counts one canonical boundary per accumulator diff observation", () => {
  const trace = (overrides: Partial<LivePipelineTraceRecord>): LivePipelineTraceRecord => ({
    schemaVersion: 1,
    ts: new Date(1).toISOString(),
    monoMs: 1,
    process: "backend",
    stage: "backend.subagent",
    kind: "success",
    ...overrides,
  });
  const blockingSpan = trace({ phase: "extension_hook" });
  assert.equal(isSubagentActivityRecord(blockingSpan), false);
  assert.deepEqual(summarizePayloadBytes([blockingSpan], "source", false), {
    status: "unavailable",
    reason: NO_SUBAGENT_ACTIVITY_REASON,
  });
  assert.deepEqual(summarizeSemanticChanges([blockingSpan]), {
    sourceUpdateCount: 0,
    semanticChanges: 0,
    duplicates: 0,
  });
  const records = [
    trace({ phase: "diff", outcome: "changed", toolHash: "tool", revision: 1, processSeq: 10 }),
    trace({ phase: "diff", outcome: "duplicate", toolHash: "tool", revision: 1, processSeq: 11 }),
    trace({ phase: "diff", outcome: "changed", toolHash: "tool", revision: 2, processSeq: 12 }),
    // Runner/settlement dedupe instrumentation never carries the diff phase
    // plus revision/toolHash/outcome, so it never becomes a source boundary.
    trace({ phase: "dedupe", outcome: "duplicate", toolHash: "tool", processSeq: 13 }),
    trace({ phase: "dedupe", outcome: "changed", toolHash: "tool", processSeq: 14 }),
  ];
  // A changed record at revision N followed by a duplicate re-observation of
  // revision N yields one change plus one duplicate: each diff observation is
  // its own canonical source-update boundary, keyed by processSeq.
  assert.deepEqual(summarizeSemanticChanges(records), {
    sourceUpdateCount: 3,
    semanticChanges: 2,
    duplicates: 1,
  });
  const terminalRecords = [
    trace({ phase: "terminal", payloadClass: "terminal_transport", producedPayloadBytes: 128 }),
    trace({ phase: "terminal", payloadClass: "terminal_append", availabilityReason: "sdk_durability_boundary_exposes_no_serialized_byte_counter" }),
  ];
  assert.equal(summarizePayloadBytes(terminalRecords, "terminal_transport", true).producedPayloadBytes, 128);
  assert.deepEqual(summarizePayloadBytes(terminalRecords, "terminal_append", true), {
    status: "unavailable",
    recordCount: 1,
    reason: "sdk_durability_boundary_exposes_no_serialized_byte_counter",
  });
});

async function runBlockingScenario(phase: Scenario): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pie-phase-0-${phase}-`));
  const provider = await startProvider();
  let harness: BackendHarness | undefined;
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  let timeline: ReturnType<typeof createTimeline> | undefined;
  let trigger: Promise<RpcResponse> | undefined;
  let controlRequests: Promise<RpcResponse>[] = [];
  let scenarioError: unknown;
  let wasEntered = false;
  let continuedAfterRelease = false;
  const rememberFailure = (error: unknown): void => {
    if (scenarioError === undefined) scenarioError = error;
  };
  try {
    const backendPath = await buildTestOwnedBackendArtifact(tempDir);
    fixture = await createFixture(tempDir, phase, provider.port);
    timeline = createTimeline(fixture.runId, phase);
    harness = startBackend(tempDir, fixture, phase, backendPath);
    timeline.mark("process.spawned", { processRole: "backend", pid: harness.child.pid, phase });
    await harness.waitForEvent("backend.ready", STARTUP_DEADLINE_MS);
    timeline.mark("process.ready", { processRole: "backend", pid: harness.child.pid, phase });
    trigger = harness.request("message.send", { sessionPath: fixture.sessionA, text: "phase 0 liveness", inputs: [] }, STARTUP_DEADLINE_MS);
    void trigger.catch(() => undefined);
    try {
      await waitForFile(fixture.entered, MARKER_DEADLINE_MS);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nbackend stderr: ${harness.stderr}`);
    }
    wasEntered = true;
    const entered = readFixtureMarker(fixture.entered);
    assert.equal(entered.phase, phase);
    assert.equal(entered.runId, fixture.runId);
    assert.equal(entered.reason, expectedEnteredReason(phase));
    assert.notEqual(entered.pid, harness.child.pid, "the synchronous block must run in a worker process, not the coordinator");
    timeline.mark("phase.entered", { processRole: "worker", pid: entered.pid, phase, reason: entered.reason, wallMs: entered.wallMs });

    const controls: ReadonlyArray<readonly [ControlMethod, unknown?]> = [
      ["app.ping", undefined],
      ["session.open", { sessionPath: fixture.sessionB, transcript: "skip" }],
      ["settings.get", undefined],
      ["models.list", { sessionPath: fixture.sessionB }],
    ];
    // The release marker is absent for this entire await. In legacy mode the
    // bounded request deadline fails causally; finally still releases A and
    // records any late response receipts without weakening the ordering claim.
    controlRequests = controls.map(([method, params]) => harness!.request(method, params, CONTROL_RESPONSE_DEADLINE_MS, (response) => {
      const releasePresent = existsSync(fixture!.release);
      timeline!.mark("control.response.received", {
        processRole: "backend",
        pid: harness!.child.pid,
        method,
        responseOk: response.ok === true,
        releasePresent,
      });
    }));
    const controlResponses = await Promise.all(controlRequests);
    assert.ok(controlResponses.every((response) => response.ok === true), "all control responses must succeed");
    const beforeMethods = timeline.events.filter((event): event is HarnessTimelineEvent & { method: ControlMethod } => event.marker === "control.response.received" && event.releasePresent === false && event.method !== undefined).map((event) => event.method);
    assert.deepEqual(new Set(beforeMethods), new Set(CONTROL_METHODS));
  } catch (error) {
    rememberFailure(error);
  } finally {
    if (fixture && timeline) {
      wasEntered = wasEntered || await exists(fixture.entered);
      try {
        // Capture the epoch before publishing the file. The blocked child can
        // observe and record `continued` between write completion and this
        // harness callback, so taking Date.now() afterward would invert the
        // cross-process marker order at millisecond resolution.
        const releaseCreatedAt = Date.now();
        await fs.writeFile(fixture.release, "release\n");
        timeline.mark("release.created", { processRole: "harness", phase, wallMs: releaseCreatedAt });
      } catch (error) {
        rememberFailure(error);
      }
      if (wasEntered) {
        try {
          await waitForFile(fixture.continued, STARTUP_DEADLINE_MS);
          const continued = readFixtureMarker(fixture.continued);
          assert.equal(continued.phase, phase);
          assert.equal(continued.runId, fixture.runId);
          assert.notEqual(continued.pid, harness?.child.pid, "the released block must continue in the worker process");
          timeline.mark("phase.continued", {
            processRole: "worker",
            pid: continued.pid,
            phase,
            reason: continued.reason,
            wallMs: continued.wallMs,
          });
          continuedAfterRelease = true;
        } catch (error) {
          rememberFailure(error);
        }
      }

      // Let every bounded control request record a late receipt (if legacy
      // mode only became responsive after release) before process cleanup.
      await Promise.allSettled(controlRequests);
      await trigger?.catch(() => undefined);
      const receiptDeadline = Date.now() + CONTROL_RESPONSE_DEADLINE_MS;
      while (timeline.events.filter((event) => event.marker === "control.response.received").length < CONTROL_METHODS.length
        && Date.now() < receiptDeadline) {
        await sleep(25);
      }
      const receiptCount = timeline.events.filter((event) => event.marker === "control.response.received").length;
      if (receiptCount !== CONTROL_METHODS.length) {
        rememberFailure(new Error(`Expected ${CONTROL_METHODS.length} control response receipts; observed ${receiptCount}.`));
      }

      let backendRecords: LivePipelineTraceRecord[] = [];
      try {
        backendRecords = await waitForStableBackendTrace(fixture.traceDir, fixture.runIdHash);
      } catch (error) {
        rememberFailure(error);
      }
      if (harness) {
        try {
          let capture: ProcessCapture | undefined;
          const cleanup = await harness.close((captured) => {
            capture = captured;
            timeline!.mark("cleanup.started", {
              processRole: "harness",
              pid: harness!.child.pid,
              phase,
              capturedProcesses: captured.captured,
              rootAliveAtCapture: captured.rootAliveAtCapture,
            });
          });
          assert.ok(capture, "cleanup must capture ancestry before termination");
          assert.equal(capture.rootAliveAtCapture, true, "cleanup must capture ancestry while the backend root is alive");
          assert.ok(cleanup.captured.some((entry) => entry.pid === harness!.child.pid && entry.identity !== null), "cleanup must retain the live root's process identity");
          const verification = await verifyCapturedIdentitiesGone(cleanup.captured);
          assert.equal(verification.available, true, "cleanup must be able to inspect captured process identities");
          assert.deepEqual(verification.survivors, [], "captured process identities must be gone after cleanup");
          assert.equal(cleanup.gone, true);
          timeline.mark("cleanup.completed", {
            processRole: "harness",
            phase,
            ownedPids: cleanup.ownedPids,
            survivorPids: cleanup.survivors,
            rootAliveAtCapture: cleanup.rootAliveAtCapture,
            ownedPidCount: cleanup.ownedPids.length,
            survivorPidCount: cleanup.survivors.length,
            identityVerification: "gone",
          });
        } catch (error) {
          rememberFailure(error);
        }
      }

      try {
        const finalRecords = await readBackendTrace(fixture.traceDir, fixture.runIdHash);
        if (finalRecords.length >= backendRecords.length) backendRecords = finalRecords;
      } catch (error) {
        rememberFailure(error);
      }
      try {
        if (backendRecords.length === 0) rememberFailure(new Error("spawned scenario must produce linked backend trace records"));
        const artifact = buildTimelineArtifact(fixture, phase, timeline.events, backendRecords);
        const expectedPath = fixture.timelinePath;
        await fs.writeFile(expectedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
        const parsed = JSON.parse(await fs.readFile(expectedPath, "utf8")) as unknown;
        try {
          validateTimelineArtifact(parsed, fixture, phase);
        } catch (error) {
          rememberFailure(error);
        }
        const retainedDir = process.env.PIE_PHASE_0_TRACE_DIR?.trim();
        if (retainedDir) {
          await fs.mkdir(retainedDir, { recursive: true });
          const retainedPath = path.join(retainedDir, `${phase}-${fixture.runId}.timeline.json`);
          await fs.copyFile(expectedPath, retainedPath);
          try {
            validateTimelineArtifact(JSON.parse(await fs.readFile(retainedPath, "utf8")) as unknown, fixture, phase);
          } catch (error) {
            rememberFailure(error);
          }
        }
      } catch (error) {
        rememberFailure(error);
      }
    }
    try {
      await new Promise<void>((resolve, reject) => provider.server.close((error) => error ? reject(error) : resolve()));
    } catch (error) {
      rememberFailure(error);
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      rememberFailure(error);
    }
    if (wasEntered && !continuedAfterRelease) rememberFailure(new Error("Blocking A fixture did not continue after the externally controlled release marker."));
  }
  if (scenarioError !== undefined) throw scenarioError;
}

test("Phase 4: A execution hook cannot starve coordinator controls", {
  timeout: 180_000,
  skip: RUN_LIVENESS ? false : LIVENESS_OPT_IN,
}, async () => {
  await runBlockingScenario("execution-hook");
});

test("Phase 4: A synchronous factory/resource bootstrap cannot starve coordinator controls", {
  timeout: 180_000,
  skip: RUN_LIVENESS ? false : LIVENESS_OPT_IN,
}, async () => {
  await runBlockingScenario("factory");
});
