import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

// The shared watchdog is JavaScript-only and intentionally has no production
// TypeScript dependency. Keep the test seam typed locally at the call site.
// @ts-expect-error The repository test helper is an ESM .mjs module without a declaration file.
import { snapshotProcessTree, terminateProcessTree } from '../../../../scripts/lib/process-watchdog.mjs';

const RUN_CRASH_MATRIX = process.env.PIE_RUN_SESSION_RUNTIME_CRASH_MATRIX === '1';
const CRASH_MATRIX_OPT_IN =
  'Spawned two-hot-worker crash matrix is opt-in because it builds a packaged backend twice. ' +
  'Set PIE_RUN_SESSION_RUNTIME_CRASH_MATRIX=1 to execute the crash/kill scenario.';
const CONTROL_RESPONSE_DEADLINE_MS = 15_000;
const STARTUP_DEADLINE_MS = 90_000;
const MARKER_DEADLINE_MS = 20_000;
const IDENTITY_VERIFICATION_DEADLINE_MS = 8_000;
const TERMINAL_DEADLINE_MS = 20_000;
const PROVIDER_HOLD_DEADLINE_MS = 120_000;
const QUEUED_BEHIND_DEADLINE_MS = 4_000;

interface RpcResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

interface ProcessIdentity {
  pid: number;
  ppid: number;
  identity: string | null;
}

interface WriteOwnershipRecord {
  event: 'pie.write-ownership';
  ts: number;
  pid: number;
  seam: string;
  sessionPath: string | null;
  ownerRole: 'worker' | 'coordinator';
  workerId?: string;
  workerGeneration?: number;
  coordinatorGeneration?: number;
}

interface BackendHarness {
  child: ChildProcess;
  stderr: string;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<RpcResponse>;
  waitForEvent(event: string, timeoutMs?: number): Promise<unknown>;
  close(): Promise<{ gone: boolean; survivors: number[]; ownedPids: number[]; rootAliveAtCapture: boolean; captured: ProcessIdentity[] }>;
}

function repoPath(...parts: string[]): string {
  const cwd = process.cwd();
  const root = path.basename(cwd).toLowerCase() === 'extension' ? path.resolve(cwd, '..') : cwd;
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

function samePathKey(left: string, right: string): boolean {
  const resolveLong = (value: string): string => {
    try {
      // fs.realpathSync.native resolves Windows 8.3 short names (OWANLA~1) to
      // their long form so both processes compare the same canonical path.
      return realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const a = resolveLong(left);
  const b = resolveLong(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function waitForFile(filePath: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await exists(filePath))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for marker ${filePath}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitUntil(probe: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readProcessTable(): ProcessIdentity[] | undefined {
  try {
    if (process.platform === 'win32') {
      const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate }";
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
      return result.stdout.split(/\r?\n/u).flatMap((line) => {
        const [pid, ppid, identity] = line.trim().split('|');
        return Number(pid) > 0 ? [{ pid: Number(pid), ppid: Number(ppid), identity: identity || null }] : [];
      });
    }
    const result = spawnSync('ps', ['-e', '-o', 'pid=,ppid=,lstart='], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    return result.stdout.split(/\r?\n/u).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), identity: match[3] || null }] : [];
    });
  } catch {
    return undefined;
  }
}

async function waitForPidGone(pid: number): Promise<{ available: boolean; survivors: number[] }> {
  const deadline = Date.now() + IDENTITY_VERIFICATION_DEADLINE_MS;
  let current = readProcessTable();
  while (current === undefined || current.some((row) => row.pid === pid)) {
    if (Date.now() >= deadline) {
      return {
        available: current !== undefined,
        survivors: current === undefined ? [] : current.filter((row) => row.pid === pid).map((row) => row.pid),
      };
    }
    await sleep(50);
    current = readProcessTable();
  }
  return { available: true, survivors: [] };
}

/** Provider that holds every chat-completions response until the release
 * marker exists (bounded), and records each request arrival. */
async function startHoldingProvider(dir: string): Promise<{
  server: http.Server;
  port: number;
  arrivals: Array<{ atMs: number }>;
}> {
  const releasePath = path.join(dir, 'provider.release');
  const arrivals: Array<{ atMs: number }> = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      arrivals.push({ atMs: Date.now() });
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (existsSync(releasePath) || Date.now() - startedAt > PROVIDER_HOLD_DEADLINE_MS) {
          clearInterval(poll);
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          response.end([
            `data: ${JSON.stringify({ id: 'phase-6', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
            '',
            `data: ${JSON.stringify({ id: 'phase-6', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n'));
        }
      }, 50);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, arrivals };
}

async function createMatrixFixture(dir: string, providerPort: number): Promise<{
  agentDir: string;
  workspaceA: string;
  workspaceB: string;
  sessionA: string;
  sessionB: string;
  pidMarker: string;
  descendantMarker: string;
  uiDialogMarker: string;
  uiResponseMarker: string;
  releasePath: string;
  traceDir: string;
}> {
  const agentDir = path.join(dir, 'agent');
  const workspaceA = path.join(dir, 'workspace-a');
  const workspaceB = path.join(dir, 'workspace-b');
  const sessionDir = path.join(agentDir, 'sessions');
  const sessionA = path.join(sessionDir, 'a.jsonl');
  const sessionB = path.join(sessionDir, 'b.jsonl');
  const pidMarker = path.join(dir, 'a.pid');
  const descendantMarker = path.join(dir, 'a.descendant');
  const uiDialogMarker = path.join(dir, 'a.ui-dialog');
  const uiResponseMarker = path.join(dir, 'a.ui-response');
  const releasePath = path.join(dir, 'provider.release');
  const traceDir = path.join(dir, 'ownership-trace');
  await Promise.all([agentDir, workspaceA, workspaceB, sessionDir, traceDir].map((entry) => fs.mkdir(entry, { recursive: true })));
  const fixturePath = repoPath('extension', 'test', 'fixtures', 'phase6-crash-matrix-extension.ts');
  assert.ok(providerPort > 0, 'provider port must be supplied by the harness');
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'phase-6-provider',
    defaultModel: 'phase-6-model',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'always',
    extensions: [fixturePath],
  }, null, 2));
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'phase-6-provider': {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        models: [{
          id: 'phase-6-model', name: 'Phase 6 matrix model', reasoning: false, input: ['text'],
          contextWindow: 8192, maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2));
  await fs.writeFile(path.join(agentDir, 'auth.json'), JSON.stringify({
    'phase-6-provider': { type: 'api_key', key: 'phase-6-matrix-test-key' },
  }, null, 2) + '\n');
  const header = (cwd: string, id: string) => JSON.stringify({ type: 'session', id, version: 3, cwd });
  await fs.writeFile(sessionA, `${header(workspaceA, 'phase-6-a')}\n`);
  await fs.writeFile(sessionB, `${header(workspaceB, 'phase-6-b')}\n`);
  return { agentDir, workspaceA, workspaceB, sessionA, sessionB, pidMarker, descendantMarker, uiDialogMarker, uiResponseMarker, releasePath, traceDir };
}

async function buildTestOwnedBackendArtifact(dir: string): Promise<string> {
  const artifactDir = path.join(dir, 'backend-artifact');
  const viteCli = repoPath('extension', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!(await exists(viteCli))) {
    throw new Error(
      `Phase 6 crash matrix needs the local Vite build tool at ${viteCli}. ` +
      'Run npm ci, then npm run extension:build before retrying the env-enabled characterization.',
    );
  }
  const result = spawnSync(process.execPath, [viteCli, 'build', '--mode', 'node', '--outDir', artifactDir, '--emptyOutDir'], {
    cwd: repoPath('extension'),
    encoding: 'utf8',
    timeout: STARTUP_DEADLINE_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const diagnostics = `${typeof result.stdout === 'string' ? result.stdout : ''}${typeof result.stderr === 'string' ? result.stderr : ''}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(
      `Phase 6 crash matrix could not build its test-owned backend artifact. ` +
      'Run npm run extension:build and retry the env-enabled characterization.' +
      (diagnostics ? `\n${diagnostics.slice(-4_000)}` : ''),
    );
  }
  const backendPath = path.join(artifactDir, 'backend.js');
  if (!(await exists(backendPath))) {
    throw new Error(
      `Phase 6 crash matrix build completed without ${backendPath}. ` +
      'Run npm run extension:build and retry the env-enabled characterization.',
    );
  }
  return backendPath;
}

function startBackend(dir: string, fixture: Awaited<ReturnType<typeof createMatrixFixture>>, backendPath: string): BackendHarness {
  const sdkPath = repoPath('extension', 'node_modules', '@earendil-works', 'pi-coding-agent');
  assert.ok(path.isAbsolute(backendPath));
  const child = spawn(process.execPath, [backendPath, '--sdkPath', sdkPath, '--cwd', fixture.workspaceA], {
    cwd: fixture.workspaceA,
    env: {
      ...process.env,
      // The harness process itself carries the real pie agent-dir overrides;
      // the fixture backend must resolve auth/models/settings strictly from
      // the fixture agent dir, so strip the inherited authority overrides.
      PI_CODING_AGENT_AUTH_DIR: undefined,
      PI_CODING_AGENT_DIR: fixture.agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(fixture.agentDir, 'sessions'),
      PIE_P6_MATRIX_TARGET_CWD: fixture.workspaceA,
      PIE_P6_MATRIX_PID_MARKER: fixture.pidMarker,
      PIE_P6_MATRIX_DESCENDANT_MARKER: fixture.descendantMarker,
      PIE_P6_MATRIX_UI_DIALOG_MARKER: fixture.uiDialogMarker,
      PIE_P6_MATRIX_UI_RESPONSE_MARKER: fixture.uiResponseMarker,
      PIE_P6_MATRIX_DEADLINE_MS: String(PROVIDER_HOLD_DEADLINE_MS),
      PI_DIAG: '1',
      PIE_PROVIDER_TRAFFIC_LOG: '1',
      PIE_WRITE_OWNERSHIP_TRACE_DIR: fixture.traceDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  assert.ok(child.stdin && child.stdout && child.stderr);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-32 * 1024);
  });
  const responses = new Map<string, (response: RpcResponse) => void>();
  const events = new Map<string, Array<(payload: unknown) => void>>();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let envelope: RpcResponse & { event?: string; payload?: unknown };
    try { envelope = JSON.parse(line) as typeof envelope; } catch { return; }
    if (typeof envelope.id === 'string') responses.get(envelope.id)?.(envelope);
    if (typeof envelope.event === 'string') {
      const waiters = events.get(envelope.event) ?? [];
      events.delete(envelope.event);
      for (const waiter of waiters) waiter(envelope.payload);
    }
  });
  const waitFor = <T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs}ms\nstderr: ${stderr}`)), timeoutMs);
    timeout.unref?.();
    operation.then(resolve, (error) => reject(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}\nstderr: ${stderr}`)))
      .finally(() => clearTimeout(timeout));
  });
  let requestId = 0;
  return {
    child,
    get stderr() { return stderr; },
    request(method, params, timeoutMs = CONTROL_RESPONSE_DEADLINE_MS) {
      const id = `phase-6-${++requestId}`;
      return waitFor(new Promise<RpcResponse>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          reject(new Error(`timed out waiting for ${method} response`));
        }, timeoutMs);
        timer.unref?.();
        responses.set(id, (response) => {
          clearTimeout(timer);
          responses.delete(id);
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
    async close() {
      const capture = {
        captured: snapshotProcessTree(child.pid),
        rootAliveAtCapture: child.exitCode === null && child.signalCode === null,
      };
      const cleanup = await terminateProcessTree(child);
      try { child.stdin?.destroy(); } catch { /* already closed */ }
      responses.clear();
      lines.close();
      return { ...cleanup, rootAliveAtCapture: capture.rootAliveAtCapture, captured: capture.captured };
    },
  };
}

function readWriteOwnershipRecords(traceDir: string): WriteOwnershipRecord[] {
  const records: WriteOwnershipRecord[] = [];
  const files = (() => {
    try { return readdirSync(traceDir).filter((name) => name.startsWith('write-ownership-') && name.endsWith('.jsonl')); } catch { return []; }
  })();
  for (const name of files.sort()) {
    const data = (() => {
      try { return readFileSync(path.join(traceDir, name), 'utf8'); } catch { return ''; }
    })();
    for (const line of data.split(/\r?\n/u).filter(Boolean)) {
      try {
        records.push(JSON.parse(line) as WriteOwnershipRecord);
      } catch {
        // A torn trace line is ignored; the surrounding records still count.
      }
    }
  }
  return records.sort((left, right) => left.ts - right.ts);
}

function sessionEntries(sessionPath: string): Array<{
  type: string;
  customType?: string;
  pid?: number;
  role?: string;
  text?: string;
  id?: string;
  parentId?: string | null;
}> {
  const data = (() => {
    try { return readFileSync(sessionPath, 'utf8'); } catch { return ''; }
  })();
  const entries: Array<{
    type: string;
    customType?: string;
    pid?: number;
    role?: string;
    text?: string;
    id?: string;
    parentId?: string | null;
  }> = [];
  for (const line of data.split(/\r?\n/u).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        customType?: string;
        content?: unknown;
        id?: string;
        parentId?: string | null;
        message?: { role?: string; content?: unknown };
      };
      const text = Array.isArray(parsed.message?.content)
        ? parsed.message.content
          .filter((part): part is { type: string; text?: unknown } => typeof part === 'object' && part !== null && 'type' in part)
          .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
          .join(' ')
        : undefined;
      entries.push({
        type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
        ...(typeof parsed.customType === 'string' ? { customType: parsed.customType } : {}),
        ...(typeof parsed.message?.role === 'string' ? { role: parsed.message.role } : {}),
        ...(text ? { text } : {}),
        ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
        ...(typeof parsed.parentId === 'string' ? { parentId: parsed.parentId } : { parentId: null }),
      });
    } catch {
      // Unparseable trailing content does not affect entry classification.
    }
  }
  return entries;
}

async function runCrashMatrix(): Promise<void> {
  const runId = randomUUID();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pie-phase-6-matrix-${runId.slice(0, 8)}-`));
  let provider: Awaited<ReturnType<typeof startHoldingProvider>> | undefined;
  let harness: BackendHarness | undefined;
  let fixture: Awaited<ReturnType<typeof createMatrixFixture>> | undefined;
  const failures: unknown[] = [];
  const remember = (error: unknown): void => { failures.push(error); };
  let killTimestamp = 0;
  let workerAPid = 0;
  let replacementPid = 0;
  let dialogId = '';
  let descendantPid = 0;
  try {
    const backendPath = await buildTestOwnedBackendArtifact(tempDir);
    provider = await startHoldingProvider(tempDir);
    fixture = await createMatrixFixture(tempDir, provider.port);
    assert.ok(fixture, 'matrix fixture must be created');
    harness = startBackend(tempDir, fixture, backendPath);
    await harness.waitForEvent('backend.ready', STARTUP_DEADLINE_MS);

    // Promote A and open a pending extension UI dialog inside its worker.
    const openedA = await harness.request('session.open', { sessionPath: fixture.sessionA, transcript: 'skip' });
    assert.equal(openedA.ok, true, 'A must promote to a hot worker');
    await fs.writeFile(fixture.uiDialogMarker, 'open\n');
    const sendA = harness.request('message.send', { sessionPath: fixture.sessionA, text: 'phase 6 matrix A', inputs: [] }, STARTUP_DEADLINE_MS);
    const dialogEvent = await harness.waitForEvent('extension_ui.request', MARKER_DEADLINE_MS) as { id?: unknown; sessionPath?: unknown };
    assert.equal(typeof dialogEvent.id, 'string');
    assert.ok(samePathKey(dialogEvent.sessionPath as string, fixture.sessionA), 'the dialog must belong to session A');
    dialogId = dialogEvent.id as string;
    await waitForFile(fixture.pidMarker, MARKER_DEADLINE_MS);
    const pidMarkerA = JSON.parse(readFileSync(fixture.pidMarker, 'utf8')) as { pid: number; enteredAt: number };
    workerAPid = pidMarkerA.pid;
    assert.notEqual(workerAPid, harness.child.pid, 'the fixture hook must run in a worker process, not the coordinator');
    await waitForFile(fixture.descendantMarker, MARKER_DEADLINE_MS);
    descendantPid = (JSON.parse(readFileSync(fixture.descendantMarker, 'utf8')) as { pid: number }).pid;
    assert.ok(isAlive(descendantPid), 'the fixture descendant must be alive before the kill');

    // Promote B and verify coordinator controls while A is alive.
    const openedB = await harness.request('session.open', { sessionPath: fixture.sessionB, transcript: 'skip' });
    assert.equal(openedB.ok, true, 'B must promote to a hot worker');
    for (const [method, params] of [
      ['app.ping', undefined],
      ['settings.get', undefined],
      ['models.list', { sessionPath: fixture.sessionB }],
    ] as const) {
      const response = await harness.request(method, params);
      assert.equal(response.ok, true, `${method} must succeed while A holds a pending dialog`);
    }

    // B's provider request must queue behind A's provider lease (coordinator
    // gate): the provider may only have seen A's request.
    const sendB = harness.request('message.send', { sessionPath: fixture.sessionB, text: 'phase 6 matrix B', inputs: [] }, STARTUP_DEADLINE_MS);
    let sendAResultSettled = false;
    let sendAOutcome: RpcResponse | undefined;
    void sendA.then((response) => { sendAResultSettled = true; sendAOutcome = response; }, () => { sendAResultSettled = true; });
    await sleep(QUEUED_BEHIND_DEADLINE_MS);
    assert.equal(provider.arrivals.length, 1, `B must not reach the provider while A holds the network lease (arrivals=${provider.arrivals.length}, sendA settled=${sendAResultSettled})\nbackend stderr: ${harness.stderr.slice(-6000)}`);

    // Kill ONLY A's worker root process (single process, not the tree). The
    // coordinator must observe the exit, clean up the orphaned descendant
    // tree, terminalize A without replay, and release A's provider lease.
    // message.send is early-acked, so terminalization arrives as a correlated
    // runtime event (message.aborted once the turn started, preflight.failed
    // if it had not yet). Register the waiters before the kill.
    const terminalEvent = Promise.race([
      harness.waitForEvent('message.aborted', TERMINAL_DEADLINE_MS).then((event) => ({ event: 'message.aborted', ...(event as object) })),
      harness.waitForEvent('preflight.failed', TERMINAL_DEADLINE_MS).then((event) => ({ event: 'preflight.failed', ...(event as object) })),
    ]);
    killTimestamp = Date.now();
    try {
      process.kill(workerAPid);
    } catch (error) {
      remember(error instanceof Error ? error : new Error(String(error)));
    }
    const abortedEvent = await terminalEvent;
    assert.equal(
      (abortedEvent as { requestId?: string }).requestId,
      (sendAOutcome?.result as { requestId?: string } | undefined)?.requestId,
      `A's interrupted message must terminalize with its early-ack request identity (${abortedEvent.event})`,
    );
    const sendAResult = await sendA.catch((error) => ({ ok: false, error: { code: 'HARNESS_TIMEOUT', message: String(error) } }));
    assert.equal(sendAResult.ok, true, 'the early-acked message.send RPC itself must still succeed');
    await waitForPidGone(workerAPid).then(({ available, survivors }) => {
      assert.equal(available, true, 'process table must be inspectable to confirm worker A exit');
      assert.deepEqual(survivors, [], 'worker A root process must be confirmed dead before replacement');
    });
    await waitUntil(() => !isAlive(descendantPid), IDENTITY_VERIFICATION_DEADLINE_MS, 'the orphaned descendant of worker A to be reaped');

    // B controls must survive A's crash.
    for (const [method, params] of [
      ['app.ping', undefined],
      ['settings.get', undefined],
      ['models.list', { sessionPath: fixture.sessionB }],
    ] as const) {
      const response = await harness.request(method, params);
      assert.equal(response.ok, true, `${method} must succeed after A's worker died`);
    }

    // A late response for A's dialog must be correlated typed-stale and must
    // never invoke any worker callback.
    const late = await harness.request('extension_ui.response', {
      sessionPath: fixture.sessionA,
      response: { id: dialogId, value: 'option-a' },
    });
    assert.equal(late.ok, false, 'late extension UI response must be rejected');
    assert.equal(late.error?.code, 'UI_REQUEST_NOT_PENDING', 'late response must carry the typed stale code');

    // Release the provider; B's queued turn must now complete (its lease was
    // released by A's crash) and its session must gain a durable assistant
    // entry from B's own worker generation.
    await fs.writeFile(fixture.releasePath, 'release\n');
    const sendBResult = await sendB;
    assert.equal(sendBResult.ok, true, "B's queued message must complete after A's lease is released");
    const providerArrivalCount = provider.arrivals.length;
    assert.equal(providerArrivalCount, 2, 'the provider must have served exactly A then B');
    assert.ok(provider.arrivals[1]!.atMs > killTimestamp, "B's provider request must arrive only after A's crash");
    await waitUntil(
      () => sessionEntries(fixture!.sessionB).some((entry) => entry.type === 'message' && entry.role === 'assistant'),
      MARKER_DEADLINE_MS,
      "B's durable assistant entry after its lease is released",
    );

    // Replacement: promote A again (old-process exit already confirmed) and
    // run a fresh turn; it must append with the NEW worker generation and the
    // old request must not be replayed.
    await fs.writeFile(fixture.pidMarker, ''); // stale marker content is overwritten by the new hook run
    const reopenedA = await harness.request('session.open', { sessionPath: fixture.sessionA, transcript: 'skip' });
    assert.equal(reopenedA.ok, true, 'A must be promotable after confirmed exit');
    const replacementSend = await harness.request('message.send', { sessionPath: fixture.sessionA, text: 'phase 6 replacement', inputs: [] }, STARTUP_DEADLINE_MS);
    assert.equal(replacementSend.ok, true, "A's replacement turn must complete");
    await waitForFile(fixture.pidMarker, MARKER_DEADLINE_MS);
    const pidMarkerReplacement = JSON.parse(readFileSync(fixture.pidMarker, 'utf8')) as { pid: number; enteredAt: number };
    replacementPid = pidMarkerReplacement.pid;
    assert.notEqual(replacementPid, workerAPid, 'the replacement turn must run in a NEW worker process');
    await waitUntil(
      () => sessionEntries(fixture!.sessionA).filter((entry) => entry.type === 'message' && entry.role === 'assistant').length >= 1,
      MARKER_DEADLINE_MS,
      "A's replacement turn to complete and append its assistant entry",
    );
    await sleep(500); // let the terminal append settle

    // No replay: the killed 'phase 6 matrix A' turn must never gain an
    // assistant reply from any later worker generation.
    const finalEntriesA = sessionEntries(fixture.sessionA);
    const killedUserMessage = finalEntriesA.find(
      (entry) => entry.type === 'message' && entry.role === 'user' && entry.text === 'phase 6 matrix A',
    );
    assert.ok(killedUserMessage?.id, "A's killed user message must remain in the session");
    assert.equal(
      finalEntriesA.filter(
        (entry) => entry.type === 'message' && entry.role === 'assistant' && entry.parentId === killedUserMessage.id,
      ).length,
      0,
      "A's killed message must never be replayed into an assistant reply",
    );

    // Write-ownership trace: no stale appends and no overlapping ownership.
    const traceDir = fixture.traceDir;
    const sessionA = fixture.sessionA;
    const sessionB = fixture.sessionB;
    const records = readWriteOwnershipRecords(traceDir);
    assert.ok(records.length >= 4, 'the ownership trace must contain at least the pid entries and terminal appends');
    const aRecords = records.filter((record) => record.sessionPath !== null && samePathKey(record.sessionPath, sessionA));
    const bRecords = records.filter((record) => record.sessionPath !== null && samePathKey(record.sessionPath, sessionB));
    assert.ok(aRecords.length >= 3, 'session A must have worker-owned append records');
    assert.ok(bRecords.length >= 3, 'session B must have worker-owned append records');
    const aWorkerIds = new Set(aRecords.map((record) => record.workerId));
    assert.equal(aWorkerIds.size, 2, 'exactly two worker generations must ever write session A');
    assert.ok(aRecords.every((record) => record.ownerRole === 'worker'), 'no coordinator cold write may touch a hot-owned session');
    // The replacement worker's first append must be strictly after the old
    // worker's last append and after the confirmed kill.
    const oldTs = Math.max(...aRecords.filter((record) => record.pid === workerAPid).map((record) => record.ts));
    const newTs = Math.min(...aRecords.filter((record) => record.pid === replacementPid).map((record) => record.ts));
    assert.ok(oldTs < killTimestamp, 'the old worker must not append after the kill');
    assert.ok(newTs > killTimestamp, 'the replacement worker must append only after the confirmed kill');
    assert.ok(oldTs < newTs, 'old and replacement ownership must not overlap');
    assert.equal(new Set(bRecords.map((record) => record.workerId)).size, 1, 'session B must be written by exactly one worker generation');

    const aEntries = sessionEntries(sessionA);
    const assistantCount = aEntries.filter((entry) => entry.type === 'message' && entry.role === 'assistant').length;
    assert.equal(assistantCount, 1, 'session A must have exactly one assistant entry: the replacement turn, never a replay');
    const pidEntries = aEntries.filter((entry) => entry.customType === 'phase6-matrix-pid').length;
    assert.equal(pidEntries, 2, 'session A must carry one durable pid entry per worker generation');
  } catch (error) {
    remember(error);
  } finally {
    if (provider) {
      try { await new Promise<void>((resolve) => provider!.server.close(() => resolve())); } catch { /* already closed */ }
    }
    if (harness) {
      try {
        const cleanup = await harness.close();
        assert.equal(cleanup.rootAliveAtCapture, true, 'cleanup must capture ancestry while the backend root is alive');
        assert.ok(cleanup.ownedPids.length > 0, 'cleanup must capture backend process ancestry');
        assert.equal(cleanup.gone, true, 'the backend tree must be fully terminated');
        for (const pid of [workerAPid, descendantPid, replacementPid]) {
          if (pid > 0) {
            const { survivors } = await waitForPidGone(pid);
            assert.deepEqual(survivors, [], 'every captured worker identity must be gone after cleanup');
          }
        }
      } catch (error) {
        remember(error);
      }
    }
    if (failures.length > 0 && process.env.PIE_PHASE6_MATRIX_RETAIN_DIR?.trim()) {
      console.error('PHASE6 MATRIX RETAINED DIR', tempDir);
    } else {
      try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (failures.length > 0) throw failures[0];
}

test('Phase 6: two-hot-worker crash matrix — B and coordinator controls survive A, A terminalizes without replay, descendants/UI/provider release, replacement waits for confirmed exit', {
  timeout: 300_000,
  skip: RUN_CRASH_MATRIX ? false : CRASH_MATRIX_OPT_IN,
}, async () => {
  await runCrashMatrix();
});
