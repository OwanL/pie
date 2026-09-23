import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import test from 'node:test';

import {
  canonicalAnalyticsToolEntityId,
} from '../../../shared/analytics/transport.js';
import type { AnalyticsTransportAcknowledgement, AnalyticsTransportPacket } from '../../../shared/analytics/transport.js';
import { AnalyticsRecorderSupervisor, type AnalyticsWorkerLifecycleEvent } from '../../../extension/src/analytics/recorder-supervisor.js';
import { SqliteAnalyticsRecorder } from '../../../extension/src/analytics/sqlite-recorder.js';
import { AnalyticsWorkerTransport } from '../../../extension/src/backend/analytics-worker-transport.js';
import { HostAnalyticsTransport } from '../../../extension/src/host/analytics-transport.js';
import { resolveInstalledSubagentAnalyticsCapture } from '../src/analytics-runtime-bridge.js';
import type { SingleResult, SubagentDetails } from '../types.js';

/**
 * These tests deliberately use the installed SDK and a loopback
 * OpenAI-compatible HTTP server. They are not part of the ordinary fast suite:
 * the loader creates real AgentSession instances, and the server is only a
 * deterministic provider fixture, not evidence about an external provider.
 */
const RUN_REAL_SDK_TESTS = process.env.PIE_RUN_INTEGRATION_TESTS === '1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SDK_ENTRY = path.join(
  REPO_ROOT,
  'extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
);
const WORKER_SCRIPT = fileURLToPath(new URL(
  '../../../extension/test/analytics/fixtures/production-recorder-worker.mjs',
  import.meta.url,
));
const WORKER_EXEC_ARGV = [
  `--import=${new URL('../../../extension/node_modules/tsx/dist/loader.mjs', import.meta.url).href}`,
];

const ENV_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PIE_SUBAGENT_BUCKETS_JSON',
  'PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON',
  'PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON',
  'PIE_SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE',
] as const;

type FixtureRequest = {
  url: string;
  model: string;
  body: Record<string, unknown>;
};

type FixtureHandler = (
  request: FixtureRequest,
  response: http.ServerResponse,
  rawRequest: http.IncomingMessage,
  requestNumber: number,
) => void | Promise<void>;

interface FixtureServer {
  server: http.Server;
  port: number;
  requests: FixtureRequest[];
  errors: unknown[];
  close: () => Promise<void>;
}

interface AnalyticsHarness {
  proofRoot: string;
  databasePath: string;
  route: {
    coordinatorGeneration: number;
    workerId: string;
    workerGeneration: number;
    workerPid: number;
    rootSessionPath: string;
    leasePath: string;
    leaseRevision: number;
  };
  acknowledgements: AnalyticsTransportAcknowledgement[];
  acknowledgedDeliveryIds: string[];
  factDeliveryIds: string[];
  detailPackets: AnalyticsTransportPacket[];
  detailStarts: Array<{ payloadId?: string; byteLength: number; sha256: string }>;
  lifecycle: AnalyticsWorkerLifecycleEvent[];
  hostErrors: Error[];
  releaseAcknowledgements: () => void;
  waitForAcknowledgements: (count: number) => Promise<void>;
  flush: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function completionChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason ? { usage } : {}),
  };
}

function sendSse(
  response: http.ServerResponse,
  chunks: Record<string, unknown>[],
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function sendText(
  response: http.ServerResponse,
  id: string,
  model: string,
  text: string,
): void {
  sendSse(response, [
    completionChunk(id, model, { role: 'assistant', content: text }, null),
    completionChunk(id, model, {}, 'stop'),
  ]);
}

function sendSubagentTool(
  response: http.ServerResponse,
  id: string,
  model: string,
  agent: string,
  task: string,
  bucket: string,
  toolCallId: string,
): void {
  sendSse(response, [
    completionChunk(id, model, {
      role: 'assistant',
      tool_calls: [{
        index: 0,
        id: toolCallId,
        type: 'function',
        function: {
          name: 'subagent',
          arguments: JSON.stringify({ agent, task, bucket }),
        },
      }],
    }, null),
    completionChunk(id, model, {}, 'tool_calls'),
  ]);
}

async function startFixtureServer(handler: FixtureHandler): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const errors: unknown[] = [];
  let requestNumber = 0;
  const server = http.createServer((rawRequest, response) => {
    void (async () => {
      try {
        let rawBody = '';
        for await (const chunk of rawRequest) rawBody += String(chunk);
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        const request: FixtureRequest = {
          url: rawRequest.url ?? '',
          model: typeof body.model === 'string' ? body.model : '',
          body,
        };
        requests.push(request);
        requestNumber += 1;
        await handler(request, response, rawRequest, requestNumber);
      } catch (error) {
        errors.push(error);
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
        if (!response.writableEnded) response.end('fixture handler failed');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    port: address.port,
    requests,
    errors,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function snapshotEnvironment(): Map<typeof ENV_KEYS[number], string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot: Map<typeof ENV_KEYS[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setEnvironment(
  root: string,
  buckets: Record<string, unknown>,
): void {
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PIE_SUBAGENT_BUCKETS_JSON = JSON.stringify(buckets);
  process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON = JSON.stringify({
    small: true,
    medium: true,
    frontier: true,
  });
  process.env.PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON = JSON.stringify({
    small: true,
    medium: true,
    frontier: true,
  });
  delete process.env.PIE_SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE;
}

function createFixtureRoot(
  agentName: string,
  bucket: string,
  disableProviderRetries = true,
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-p4-real-sdk-'));
  mkdirSync(path.join(root, 'extensions'));
  mkdirSync(path.join(root, 'agents'));
  if (disableProviderRetries) {
    // The nested and cancellation cases isolate Pie's attempt boundary from
    // the SDK's own retry loop.
    writeFileSync(
      path.join(root, 'settings.json'),
      JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
    );
  }
  writeFileSync(
    path.join(root, 'extensions', 'subagent.ts'),
    `export { default } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'extensions/subagent/index.ts')).href)};\n`,
  );
  writeFileSync(
    path.join(root, 'agents', `${agentName}.md`),
    [
      '---',
      `name: ${agentName}`,
      'description: deterministic real SDK fixture agent',
      `bucket: ${bucket}`,
      'tools: []',
      '---',
      'Complete the fixture task directly.',
      '',
    ].join('\n'),
  );
  return root;
}

function modelDefinition(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
}

async function createRealSdkSession(
  root: string,
  port: number,
  providers: Array<{ name: string; route: string; model: string }>,
  selectedProvider: string,
): Promise<{ sdk: any; session: any; registry: any; loader: any }> {
  const sdk = await import(pathToFileURL(SDK_ENTRY).href) as any;
  const auth = sdk.AuthStorage.inMemory();
  const registry = sdk.ModelRegistry.inMemory(auth);
  for (const provider of providers) {
    registry.registerProvider(provider.name, {
      baseUrl: `http://127.0.0.1:${port}/${provider.route}/v1`,
      apiKey: 'p4-real-sdk-fixture-key',
      api: 'openai-completions',
      models: [modelDefinition(provider.model)],
    });
  }
  const model = registry.getAvailable().find((candidate: any) => candidate.provider === selectedProvider);
  assert.ok(model, `missing selected provider ${selectedProvider}`);
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, [], 'the real SDK must load the disposable production extension');
  assert.ok(extensions.extensions.length >= 1, 'the real SDK extension loader must load subagent');
  const created = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: 'off',
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(root),
    tools: ['subagent'],
  });
  return { sdk, session: created.session, registry, loader };
}

async function startAnalyticsHarness(
  rootSessionId: string,
  generationId: string,
  holdAcknowledgements: boolean,
): Promise<AnalyticsHarness> {
  const proofRoot = mkdtempSync(path.join(tmpdir(), 'pie-p4-real-sdk-analytics-'));
  const databasePath = path.join(proofRoot, 'analytics.sqlite');
  const route = {
    coordinatorGeneration: 1,
    workerId: `${rootSessionId}-worker`,
    workerGeneration: 1,
    workerPid: process.pid,
    rootSessionPath: `C:/disposable/${rootSessionId}.jsonl`,
    leasePath: `C:/disposable/${rootSessionId}.jsonl`,
    leaseRevision: 1,
  };
  const lifecycle: AnalyticsWorkerLifecycleEvent[] = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: WORKER_SCRIPT,
    execArgv: WORKER_EXEC_ARGV,
    databasePath,
    maxBatchSize: 32,
    maxQueueRecords: 256,
    maxQueueBytes: 32 * 1024 * 1024,
    onWorkerLifecycle: (event) => lifecycle.push(event),
  });
  const acknowledgements: AnalyticsTransportAcknowledgement[] = [];
  const acknowledgedDeliveryIds: string[] = [];
  const factDeliveryIds: string[] = [];
  const detailPackets: AnalyticsTransportPacket[] = [];
  const detailStarts: Array<{ payloadId?: string; byteLength: number; sha256: string }> = [];
  const hostErrors: Error[] = [];
  let producerTransport: AnalyticsWorkerTransport | undefined;
  let hostTransport: HostAnalyticsTransport | undefined;
  let releaseGate!: () => void;
  const acknowledgementGate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  await supervisor.start();
  const backend = {
    getGeneration: () => route.coordinatorGeneration,
    onEvent: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    request: async <Result = unknown>(method: string, params?: unknown): Promise<Result> => {
      assert.equal(method, 'analytics.ack');
      assert.ok(params && typeof params === 'object' && !Array.isArray(params));
      assert.deepEqual(Reflect.get(params, 'route'), route);
      const acknowledgement = Reflect.get(params, 'acknowledgement') as AnalyticsTransportAcknowledgement;
      acknowledgements.push(acknowledgement);
      if (holdAcknowledgements) await acknowledgementGate;
      acknowledgedDeliveryIds.push(acknowledgement.deliveryId);
      producerTransport?.acknowledge(acknowledgement);
      return { accepted: true } as Result;
    },
  };
  hostTransport = new HostAnalyticsTransport({
    generationId,
    backend,
    recorder: supervisor,
    maxPendingDetails: 4,
    maxPendingDetailBytes: 8 * 1024 * 1024,
    onError: (error) => hostErrors.push(error),
  });
  producerTransport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      if (packet.kind === 'fact') factDeliveryIds.push(packet.deliveryId);
      if (packet.kind.startsWith('detail.')) detailPackets.push(structuredClone(packet));
      if (packet.kind === 'detail.start') {
        detailStarts.push({
          payloadId: packet.detail.payloadId,
          byteLength: packet.byteLength,
          sha256: packet.sha256,
        });
      }
      queueMicrotask(() => {
        hostTransport?.receive({ route, packet: JSON.parse(JSON.stringify(packet)) });
        onSettled?.({ status: 'sent' });
      });
      return true;
    },
    requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
  }, {
    generationId,
    captureSubject: { kind: 'session', rootSessionId },
    workspaceId: `p4-real-sdk-${rootSessionId}`,
    buildId: 'p4-real-sdk-build',
  }, 'p4-real-sdk-process');
  producerTransport.install();
  assert.ok(resolveInstalledSubagentAnalyticsCapture(), 'the installed worker bridge must be visible to the loaded subagent');

  let cleaned = false;
  return {
    proofRoot,
    databasePath,
    route,
    acknowledgements,
    acknowledgedDeliveryIds,
    factDeliveryIds,
    detailPackets,
    detailStarts,
    lifecycle,
    hostErrors,
    releaseAcknowledgements: () => releaseGate(),
    waitForAcknowledgements: async (count) => {
      const deadline = Date.now() + 10_000;
      while (acknowledgements.length < count) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${count} analytics acknowledgements (got ${acknowledgements.length})`);
        }
        await waitImmediate();
      }
    },
    flush: async () => {
      for (let index = 0; index < 10; index += 1) await waitImmediate();
      await supervisor.flush();
      for (let index = 0; index < 10; index += 1) await waitImmediate();
    },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      releaseGate();
      hostTransport?.dispose();
      await producerTransport?.dispose();
      await supervisor.shutdown();
      rmSync(proofRoot, { recursive: true, force: true });
    },
  };
}

function toolResultFor(session: any, toolCallId: string): SingleResult {
  const message = [...(session.agent.state.messages ?? [])]
    .reverse()
    .find((candidate: any) => candidate.role === 'toolResult' && candidate.toolCallId === toolCallId) as
    | { details?: SubagentDetails }
    | undefined;
  assert.ok(message, `missing tool result for ${toolCallId}`);
  const result = message.details?.results?.[0];
  assert.ok(result, `missing child result for ${toolCallId}`);
  return result as SingleResult;
}

function persistedPayloads(
  database: DatabaseSync,
  table: 'analytics_execution_observations' | 'analytics_observations',
  rootSessionId: string,
): any[] {
  const rows = database.prepare(
    `SELECT payload_json FROM ${table} WHERE root_session_id = ? ORDER BY rowid`,
  ).all(rootSessionId) as Array<{ payload_json: string }>;
  return rows.map((row) => JSON.parse(row.payload_json));
}

function assertAttribution(
  payloads: any[],
  rootSessionId: string,
  child: SingleResult,
  toolCallId: string,
): void {
  const parentToolEntityId = canonicalAnalyticsToolEntityId(rootSessionId, toolCallId);
  assert.ok(payloads.length > 0);
  for (const payload of payloads) {
    assert.deepEqual(payload.captureSubject, { kind: 'session', rootSessionId });
    assert.equal(payload.scope.rootSessionId, rootSessionId);
    assert.equal(payload.scope.sessionId, child.childId);
    assert.equal(payload.scope.parentToolCallId, parentToolEntityId);
  }
}

async function closeSessionAndServer(session: any, server: FixtureServer): Promise<void> {
  try {
    session?.dispose();
  } finally {
    await server.close();
  }
}

test('real installed SDK drives nested subagent network capture through the recorder bridge', {
  skip: !RUN_REAL_SDK_TESTS,
}, async () => {
  const agentName = 'p4-real-sdk-nested-agent';
  const toolCallId = 'p4-real-sdk-nested-tool';
  const rootSessionId = 'p4-real-sdk-nested-root';
  const generationId = 'p4-real-sdk-nested-generation';
  const environment = snapshotEnvironment();
  const root = createFixtureRoot(agentName, 'small');
  const server = await startFixtureServer(async (request, response, _rawRequest, number) => {
    if (number === 1) {
      assert.equal(request.url, '/fixture/v1/chat/completions');
      sendSubagentTool(response, 'parent-response', request.model, agentName, 'real nested child task', 'small', toolCallId);
    } else if (number === 2) {
      sendText(response, 'child-response', request.model, 'real-sdk-child-output');
    } else if (number === 3) {
      sendText(response, 'parent-response-continued', request.model, 'real-sdk-parent-output');
    } else {
      throw new Error(`unexpected nested fixture request ${number}`);
    }
  });
  let analytics: AnalyticsHarness | undefined;
  let session: any;
  let readModel: SqliteAnalyticsRecorder | undefined;
  let database: DatabaseSync | undefined;
  try {
    setEnvironment(root, {
      small: [{ model: 'fixture/fixture-model', thinkingLevel: 'off' }],
      medium: [],
      frontier: [],
    });
    analytics = await startAnalyticsHarness(rootSessionId, generationId, true);
    const created = await createRealSdkSession(
      root,
      server.port,
      [{ name: 'fixture', route: 'fixture', model: 'fixture-model' }],
      'fixture',
    );
    session = created.session;
    await session.prompt('real SDK nested parent task');

    assert.deepEqual(server.errors, []);
    assert.equal(server.requests.length, 3, 'the parent tool turn, child turn, and parent continuation must reach HTTP');
    const child = toolResultFor(session, toolCallId);
    assert.equal(child.exitCode, 0);
    assert.equal(child.stopReason, 'stop');
    assert.equal(child.finalOutput, 'real-sdk-child-output');
    assert.equal(child.provider, 'fixture');
    assert.equal(child.model, 'fixture-model');
    assert.equal(child.lineage?.[0]?.spawningToolCallId, toolCallId);
    assert.equal(child.parentToolCallId, toolCallId);
    assert.equal(child.providerInvocations?.length, 1);
    assert.equal(child.providerInvocations?.[0]?.provider, 'fixture');
    assert.equal(child.providerInvocations?.[0]?.model, 'fixture-model');
    assert.ok(child.providerInvocations?.[0]?.canonicalInvocationId);
    const receipt = child.analyticsCaptureReceipt;
    assert.ok(receipt);
    assert.equal(child.analyticsCaptureStatus, 'submitted');
    assert.deepEqual(receipt.predispatch, {
      factStatus: 'submitted',
      providerRequestCount: 1,
      providerRequestIds: [child.providerInvocations![0]!.invocationId],
      lastSubmittedSequence: 2,
      internalRetryCoverage: 'unknown',
    });
    assert.equal(receipt.lastSubmittedSequence, 4);
    assert.equal(receipt.terminalDetailComplete, false);
    assert.equal(analytics.factDeliveryIds.length, 4, 'nested execution begin/dispatch/settlement/end must reach transport');
    assert.equal(analytics.detailStarts.length, 1);
    await analytics.waitForAcknowledgements(5);
    assert.equal(analytics.acknowledgements.length, 5);
    assert.equal(analytics.acknowledgedDeliveryIds.length, 0, 'held ACKs must not reach the producer before release');
    const sealedReceipt = structuredClone(receipt);

    analytics.releaseAcknowledgements();
    await analytics.flush();
    assert.ok(analytics.acknowledgements.every((acknowledgement) => acknowledgement.status === 'durable'));
    assert.equal(analytics.acknowledgedDeliveryIds.length, 5);
    assert.equal(analytics.acknowledgements.filter((acknowledgement) => acknowledgement.completeDetailPayloadId).length, 1);
    assert.deepEqual(child.analyticsCaptureReceipt, sealedReceipt, 'late recorder ACKs must not rewrite the terminal result');
    assert.deepEqual(analytics.hostErrors, []);

    readModel = new SqliteAnalyticsRecorder(analytics.databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', rootSessionId), 2);
    assert.equal(readModel.countProviderSettlements(rootSessionId), 1);
    assert.equal(readModel.countDetails(rootSessionId), 1);
    const detail = readModel.reconstructDetail(receipt.terminalDetailPayloadId) as SingleResult;
    assert.equal(detail.childId, child.childId);
    assert.equal((detail.messages?.at(-1)?.content?.[0] as any)?.text, 'real-sdk-child-output');
    database = new DatabaseSync(analytics.databasePath, { readOnly: true });
    const executionPayloads = persistedPayloads(database, 'analytics_execution_observations', rootSessionId);
    assertAttribution(executionPayloads, rootSessionId, child, toolCallId);
    const rawPayloads = persistedPayloads(database, 'analytics_observations', rootSessionId);
    assert.equal(rawPayloads.length, 4);
    assert.equal(new Set(rawPayloads.map((payload) => payload.idempotencyKey)).size, 4);
    const providerRows = database.prepare(`
      SELECT invocation_id, provider, dispatched_model, effective_model
      FROM analytics_provider_settlements
      WHERE root_session_id = ?
    `).all(rootSessionId) as Array<{
      invocation_id: string;
      provider: string;
      dispatched_model: string;
      effective_model: string;
    }>;
    assert.deepEqual(providerRows.map((row) => ({
      invocation_id: row.invocation_id,
      provider: row.provider,
      dispatched_model: row.dispatched_model,
      effective_model: row.effective_model,
    })), [{
      invocation_id: child.providerInvocations![0]!.canonicalInvocationId,
      provider: 'fixture',
      dispatched_model: 'fixture-model',
      effective_model: 'fixture-model',
    }]);
  } finally {
    database?.close();
    readModel?.close();
    await closeSessionAndServer(session, server);
    await analytics?.cleanup();
    rmSync(root, { recursive: true, force: true });
    restoreEnvironment(environment);
  }
});

test('real SDK cancellation preserves an explicitly incomplete provider boundary', {
  skip: !RUN_REAL_SDK_TESTS,
}, async () => {
  const agentName = 'p4-real-sdk-cancel-agent';
  const toolCallId = 'p4-real-sdk-cancel-tool';
  const rootSessionId = 'p4-real-sdk-cancel-root';
  const generationId = 'p4-real-sdk-cancel-generation';
  const environment = snapshotEnvironment();
  const root = createFixtureRoot(agentName, 'small');
  let childRequestSeen!: () => void;
  let childRequestAborted!: () => void;
  let releaseChildHandler!: () => void;
  const childSeen = new Promise<void>((resolve) => { childRequestSeen = resolve; });
  const childAborted = new Promise<void>((resolve) => { childRequestAborted = resolve; });
  const releaseChild = new Promise<void>((resolve) => { releaseChildHandler = resolve; });
  const server = await startFixtureServer(async (request, response, rawRequest, number) => {
    if (number === 1) {
      sendSubagentTool(response, 'parent-response', request.model, agentName, 'real cancellation child task', 'small', toolCallId);
      return;
    }
    if (number !== 2) throw new Error(`unexpected cancellation fixture request ${number}`);
    childRequestSeen();
    let settled = false;
    const markAborted = () => {
      if (settled) return;
      settled = true;
      childRequestAborted();
    };
    rawRequest.once('aborted', markAborted);
    rawRequest.once('close', () => {
      if (rawRequest.destroyed) markAborted();
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(completionChunk(
      'child-hanging-response',
      request.model,
      { role: 'assistant', content: 'partial child output' },
      null,
    ))}\n\n`);
    await Promise.race([childAborted, releaseChild]);
    if (!response.destroyed) response.destroy();
  });
  let analytics: AnalyticsHarness | undefined;
  let session: any;
  let readModel: SqliteAnalyticsRecorder | undefined;
  let database: DatabaseSync | undefined;
  try {
    setEnvironment(root, {
      small: [{ model: 'fixture/fixture-model', thinkingLevel: 'off' }],
      medium: [],
      frontier: [],
    });
    analytics = await startAnalyticsHarness(rootSessionId, generationId, true);
    const created = await createRealSdkSession(
      root,
      server.port,
      [{ name: 'fixture', route: 'fixture', model: 'fixture-model' }],
      'fixture',
    );
    session = created.session;
    const prompt = session.prompt('real SDK cancellation parent task');
    await childSeen;
    await session.abort();
    await prompt;
    releaseChildHandler();

    assert.deepEqual(server.errors, []);
    assert.equal(server.requests.length, 2, 'cancellation must abort the child stream before a parent continuation');
    const child = toolResultFor(session, toolCallId);
    assert.equal(child.exitCode, 1);
    assert.equal(child.stopReason, 'aborted');
    assert.equal(child.failureClass, 'abort');
    assert.equal(child.provider, 'fixture');
    assert.equal(child.model, 'fixture-model');
    assert.equal(child.parentToolCallId, toolCallId);
    assert.equal(child.lineage?.[0]?.spawningToolCallId, toolCallId);
    assert.equal(child.attemptRecords?.length, 1);
    assert.equal(child.attemptRecords?.[0]?.outcome, 'aborted');
    assert.equal(child.attemptRecords?.[0]?.providerResponseObserved, false);
    const receipt = child.analyticsCaptureReceipt;
    assert.ok(receipt);
    assert.equal(receipt.predispatch?.providerRequestCount, 1);
    assert.equal(receipt.lastSubmittedSequence, 3);
    assert.equal(receipt.terminalDetailComplete, false);
    assert.equal(analytics.factDeliveryIds.length, 3, 'cancelled execution must submit begin, dispatch, and terminal facts');
    await analytics.waitForAcknowledgements(4);
    assert.equal(analytics.acknowledgedDeliveryIds.length, 0, 'held cancellation ACKs must not reach the producer before release');
    const sealedReceipt = structuredClone(receipt);

    analytics.releaseAcknowledgements();
    await analytics.flush();
    assert.deepEqual(child.analyticsCaptureReceipt, sealedReceipt);
    assert.ok(analytics.acknowledgements.every((acknowledgement) => acknowledgement.status === 'durable'));
    assert.equal(analytics.acknowledgedDeliveryIds.length, 4);
    assert.deepEqual(analytics.hostErrors, []);

    readModel = new SqliteAnalyticsRecorder(analytics.databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', rootSessionId), 2);
    assert.equal(readModel.countProviderSettlements(rootSessionId), 0, 'an aborted stream has no terminal provider response');
    assert.equal(readModel.countDetails(rootSessionId), 1);
    const detail = readModel.reconstructDetail(receipt.terminalDetailPayloadId) as SingleResult;
    assert.equal(detail.stopReason, 'aborted');
    database = new DatabaseSync(analytics.databasePath, { readOnly: true });
    const executionPayloads = persistedPayloads(database, 'analytics_execution_observations', rootSessionId);
    assertAttribution(executionPayloads, rootSessionId, child, toolCallId);
    const end = executionPayloads.find((payload) => payload.observationKind === 'end');
    assert.equal(end?.fields.outcome, 'aborted');
    assert.equal(end?.fields.captureIncomplete, true);
    assert.match(end?.fields.reason, /provider request\/response identities/i);
  } finally {
    database?.close();
    readModel?.close();
    releaseChildHandler();
    await closeSessionAndServer(session, server);
    await analytics?.cleanup();
    rmSync(root, { recursive: true, force: true });
    restoreEnvironment(environment);
  }
});

test('real SDK provider retries then fails over with provider-qualified attempts', {
  skip: !RUN_REAL_SDK_TESTS,
}, async () => {
  const agentName = 'p4-real-sdk-failover-agent';
  const toolCallId = 'p4-real-sdk-failover-tool';
  const rootSessionId = 'p4-real-sdk-failover-root';
  const generationId = 'p4-real-sdk-failover-generation';
  const environment = snapshotEnvironment();
  const originalRandom = Math.random;
  // Keep the SDK's production retry count here while removing backoff from the
  // fixture. The fixture makes every primary request fail, so the audit can
  // distinguish four provider settlements from Pie's single model failover
  // attempt without adding a test-time wait.
  const root = createFixtureRoot(agentName, 'medium', false);
  writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0, provider: { maxRetries: 0 } } }),
  );
  let parentRequests = 0;
  const server = await startFixtureServer(async (request, response, _rawRequest, number) => {
    if (request.url.includes('/primary/')) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture primary unavailable', type: 'server_error' } }));
      return;
    }
    if (request.url.includes('/fallback/')) {
      sendText(response, `fallback-response-${number}`, request.model, 'real-sdk-fallback-output');
      return;
    }
    if (!request.url.includes('/parent/')) throw new Error(`unexpected failover URL ${request.url}`);
    parentRequests += 1;
    if (parentRequests === 1) {
      sendSubagentTool(response, 'parent-response', request.model, agentName, 'real failover child task', 'medium', toolCallId);
    } else {
      sendText(response, 'parent-response-continued', request.model, 'real-sdk-parent-after-failover');
    }
  });
  let analytics: AnalyticsHarness | undefined;
  let session: any;
  let readModel: SqliteAnalyticsRecorder | undefined;
  let database: DatabaseSync | undefined;
  try {
    // selectFairly shuffles a fresh bag. A zero draw makes the first configured
    // primary entry deterministic while the retry's exclusion leaves fallback.
    Math.random = () => 0;
    setEnvironment(root, {
      small: [],
      medium: [
        { model: 'primary/primary-model', thinkingLevel: 'off' },
        { model: 'fallback/fallback-model', thinkingLevel: 'off' },
      ],
      frontier: [],
    });
    analytics = await startAnalyticsHarness(rootSessionId, generationId, true);
    const created = await createRealSdkSession(
      root,
      server.port,
      [
        { name: 'parent', route: 'parent', model: 'parent-model' },
        { name: 'primary', route: 'primary', model: 'primary-model' },
        { name: 'fallback', route: 'fallback', model: 'fallback-model' },
      ],
      'parent',
    );
    session = created.session;
    await session.prompt('real SDK failover parent task');

    assert.deepEqual(server.errors, []);
    assert.equal(server.requests.length, 7, 'parent tool, four failed primary retries, successful fallback, and parent continuation must reach HTTP');
    assert.deepEqual(server.requests.map((request) => request.url), [
      '/parent/v1/chat/completions',
      '/primary/v1/chat/completions',
      '/primary/v1/chat/completions',
      '/primary/v1/chat/completions',
      '/primary/v1/chat/completions',
      '/fallback/v1/chat/completions',
      '/parent/v1/chat/completions',
    ]);
    const child = toolResultFor(session, toolCallId);
    assert.equal(child.exitCode, 0);
    assert.equal(child.stopReason, 'stop');
    assert.equal(child.finalOutput, 'real-sdk-fallback-output');
    assert.equal(child.provider, 'fallback');
    assert.equal(child.model, 'fallback-model');
    assert.equal(child.selectedModel, 'fallback/fallback-model');
    assert.equal(child.failedModel, 'primary/primary-model');
    assert.equal(child.retryCount, 1);
    assert.equal(child.attemptRecords?.length, 2);
    assert.equal(child.attemptRecords?.[0]?.provider, 'primary');
    assert.equal(child.attemptRecords?.[0]?.model, 'primary/primary-model');
    assert.equal(child.attemptRecords?.[0]?.outcome, 'failure');
    assert.equal(child.attemptRecords?.[0]?.failureClass, 'server_error');
    assert.equal(child.attemptRecords?.[1]?.provider, 'fallback');
    assert.equal(child.attemptRecords?.[1]?.model, 'fallback/fallback-model');
    assert.equal(child.attemptRecords?.[1]?.outcome, 'success');
    assert.equal(child.providerInvocations?.length, 5);
    assert.deepEqual(child.providerInvocations?.map((invocation) => ({
      provider: invocation.provider,
      model: invocation.model,
      outcome: invocation.outcome,
    })), [
      { provider: 'primary', model: 'primary-model', outcome: 'failure' },
      { provider: 'primary', model: 'primary-model', outcome: 'failure' },
      { provider: 'primary', model: 'primary-model', outcome: 'failure' },
      { provider: 'primary', model: 'primary-model', outcome: 'failure' },
      { provider: 'fallback', model: 'fallback-model', outcome: 'success' },
    ]);
    const invocationIds = child.providerInvocations!.map((invocation) => invocation.canonicalInvocationId);
    assert.ok(invocationIds.every((invocationId) => typeof invocationId === 'string' && invocationId.length > 0));
    assert.equal(new Set(invocationIds).size, 5);
    const primaryInvocationIds = child.providerInvocations
      .filter((invocation) => invocation.provider === 'primary')
      .map((invocation) => invocation.invocationId);
    const primaryReceipt = child.attemptRecords?.[0]?.analyticsCaptureReceipt;
    assert.ok(primaryReceipt);
    assert.equal(primaryReceipt.predispatch?.providerRequestCount, 4);
    assert.deepEqual(primaryReceipt.predispatch?.providerRequestIds, primaryInvocationIds);
    assert.equal(analytics.factDeliveryIds.length, 14, 'the SDK retry loop must submit four primary and one fallback provider settlement');
    assert.equal(analytics.detailStarts.length, 2, 'failed and successful Pie attempts own independent terminal details');
    await analytics.waitForAcknowledgements(16);
    assert.equal(analytics.acknowledgedDeliveryIds.length, 0, 'held failover ACKs must not reach the producer before release');
    const sealedReceipt = structuredClone(child.analyticsCaptureReceipt);

    analytics.releaseAcknowledgements();
    await analytics.flush();
    assert.ok(analytics.acknowledgements.every((acknowledgement) => acknowledgement.status === 'durable'));
    assert.equal(analytics.acknowledgedDeliveryIds.length, 16);
    assert.deepEqual(child.analyticsCaptureReceipt, sealedReceipt);
    assert.deepEqual(analytics.hostErrors, []);

    readModel = new SqliteAnalyticsRecorder(analytics.databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', rootSessionId), 4);
    assert.equal(readModel.countProviderSettlements(rootSessionId), 5);
    assert.equal(readModel.countDetails(rootSessionId), 2);
    database = new DatabaseSync(analytics.databasePath, { readOnly: true });
    const executionPayloads = persistedPayloads(database, 'analytics_execution_observations', rootSessionId);
    assertAttribution(executionPayloads, rootSessionId, child, toolCallId);
    assert.equal(new Set(executionPayloads.map((payload) => payload.stableOriginId)).size, 2);
    const rawPayloads = persistedPayloads(database, 'analytics_observations', rootSessionId);
    assert.equal(rawPayloads.length, 14);
    assert.equal(new Set(rawPayloads.map((payload) => payload.idempotencyKey)).size, 14);
    const providerRows = database.prepare(`
      SELECT invocation_id, provider, dispatched_model, effective_model, outcome
      FROM analytics_provider_settlements
      WHERE root_session_id = ?
      ORDER BY settled_at_ms
    `).all(rootSessionId) as Array<{
      invocation_id: string;
      provider: string;
      dispatched_model: string;
      effective_model: string;
      outcome: string;
    }>;
    assert.deepEqual(providerRows.map((row) => ({
      provider: row.provider,
      dispatched_model: row.dispatched_model,
      effective_model: row.effective_model,
      outcome: row.outcome,
    })), [
      { provider: 'primary', dispatched_model: 'primary-model', effective_model: 'primary-model', outcome: 'failure' },
      { provider: 'primary', dispatched_model: 'primary-model', effective_model: 'primary-model', outcome: 'failure' },
      { provider: 'primary', dispatched_model: 'primary-model', effective_model: 'primary-model', outcome: 'failure' },
      { provider: 'primary', dispatched_model: 'primary-model', effective_model: 'primary-model', outcome: 'failure' },
      { provider: 'fallback', dispatched_model: 'fallback-model', effective_model: 'fallback-model', outcome: 'success' },
    ]);
    assert.deepEqual(
      providerRows.map((row) => row.invocation_id).sort(),
      invocationIds.slice().sort(),
      'durable provider identities must be the producer-minted invocation identities',
    );
    for (const attempt of child.attemptRecords ?? []) {
      assert.ok(attempt.analyticsCaptureReceipt);
      const detail = readModel.reconstructDetail(attempt.analyticsCaptureReceipt!.terminalDetailPayloadId) as SingleResult;
      assert.equal(detail.attemptId, attempt.attemptId);
    }
  } finally {
    Math.random = originalRandom;
    database?.close();
    readModel?.close();
    await closeSessionAndServer(session, server);
    await analytics?.cleanup();
    rmSync(root, { recursive: true, force: true });
    restoreEnvironment(environment);
  }
});
