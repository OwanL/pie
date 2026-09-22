import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';
import type { TranscriptPagePayload } from '../../../src/shared/protocol';

type FakeServer = {
  handleWorkerSessionControl(frame: unknown, sourceSessionPath: string): Promise<{
    result: Record<string, unknown>;
    afterResponse?: () => void | Promise<void>;
  }>;
  listSessionSummaries(): Promise<unknown[]>;
  handleRequest(request: { id: string; method: string; params?: unknown }): Promise<unknown>;
  workerRuntimeRouter?: { getRoute(path: string): { state: string; checkpoint?: { requestId?: string } } };
};

function serverForTests(): FakeServer {
  return new BackendServer({ sdkPath: '/sdk', cwd: '/workspace', workerEntryPath: '/worker.js' }) as unknown as FakeServer;
}

function frame(action: string, payload: Record<string, unknown> = {}): unknown {
  return { requestId: `control-${action}`, action, payload };
}

const summaries = [
  {
    path: '/workspace/current.jsonl', name: 'Current', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 4,
  },
  {
    path: '/workspace/idle.jsonl', name: 'Idle', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:01.000Z',
    messageCount: 2,
  },
];

test('session-control server projects bounded local summaries and rejects a non-local target', async () => {
  const server = serverForTests();
  server.listSessionSummaries = async () => summaries;
  server.workerRuntimeRouter = {
    getRoute: (path) => path.endsWith('current.jsonl')
      ? { state: 'hot', checkpoint: { requestId: 'active' } }
      : { state: 'cold' },
  };

  const listed = await server.handleWorkerSessionControl(frame('list'), '/workspace/current.jsonl');
  assert.equal(listed.result.scope, 'current-extension-host');
  assert.equal((listed.result.sessions as Array<{ path: string; busy: boolean }>)[0]?.busy, true);

  await assert.rejects(
    server.handleWorkerSessionControl(
      frame('read', { sessionPath: '/other-window/foreign.jsonl', direction: 'latest' }),
      '/workspace/current.jsonl',
    ),
    /not owned by the current extension host/,
  );
});

test('session-control server delegates cold-session creation with an idempotent operation identity', async () => {
  const server = serverForTests();
  let request: { id: string; method: string; params?: unknown } | undefined;
  server.handleRequest = async (value) => {
    request = value;
    return { ok: true, sessionPath: '/workspace/new.jsonl' };
  };

  const created = await server.handleWorkerSessionControl(
    frame('create', { cwd: '/workspace/project' }),
    '/workspace/current.jsonl',
  );
  assert.deepEqual(created.result, { ok: true, sessionPath: '/workspace/new.jsonl' });
  assert.equal(request?.method, 'session.create');
  assert.deepEqual(request?.params, {
    cwd: '/workspace/project', agentCreated: true,
    operationId: 'agent-session:control-create', operationAttempt: 1,
  });
});

test('session-control server addresses a newly created retained cold session despite a stale warm catalog', async () => {
  const server = serverForTests();
  const newSessionPath = '/workspace/new.jsonl';
  server.listSessionSummaries = async () => summaries;
  const coordinator = server as unknown as {
    retainColdSessionManager(handle: { sessionPath: string }, creationReason: 'new'): void;
  };
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    requests.push(request);
    if (request.method === 'session.create') {
      // Mirror the normal coordinator create callback: the durable cold-store
      // handle is authoritative before the create acknowledgement is returned.
      coordinator.retainColdSessionManager({ sessionPath: newSessionPath }, 'new');
      return { ok: true, sessionPath: newSessionPath };
    }
    return { accepted: true };
  };

  const created = await server.handleWorkerSessionControl(
    frame('create', { cwd: '/workspace/project' }),
    '/workspace/current.jsonl',
  );
  assert.deepEqual(created.result, { ok: true, sessionPath: newSessionPath });

  await server.handleWorkerSessionControl(
    frame('message', { sessionPath: newSessionPath, text: 'wake the new session' }),
    '/workspace/current.jsonl',
  );
  await server.handleWorkerSessionControl(
    frame('close', { sessionPath: newSessionPath }),
    '/workspace/current.jsonl',
  );

  assert.deepEqual(requests.map((request) => request.method), [
    'session.create', 'message.send', 'session.lifecycleClose',
  ]);
  assert.equal((requests[1]?.params as { sessionPath: string }).sessionPath, newSessionPath);
  assert.equal((requests[2]?.params as { sessionPath: string }).sessionPath, newSessionPath);
});

test('session-control server adapts transcript cursors and ordinary message sends', async () => {
  const server = serverForTests();
  server.listSessionSummaries = async () => summaries;
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    requests.push(request);
    if (request.method === 'session.loadTranscriptPage') {
      return {
        sessionPath: '/workspace/idle.jsonl',
        transcript: [
          { id: 'old', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'old', status: 'completed' },
          { id: 'new', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', markdown: 'new', status: 'completed' },
        ],
        transcriptWindow: {
          totalCount: 10, loadedStart: 4, loadedEnd: 6,
          hasOlder: true, hasNewer: true, isPartial: true, hasUserMessages: true,
        },
        busy: false,
      } satisfies TranscriptPagePayload;
    }
    return { accepted: true };
  };

  const page = await server.handleWorkerSessionControl(
    frame('read', {
      sessionPath: '/workspace/idle.jsonl', direction: 'newer', cursor: { start: 0, end: 4 }, limit: 1,
    }),
    '/workspace/current.jsonl',
  );
  assert.deepEqual(page.result.cursor, { start: 4, end: 5 });
  assert.equal(requests[0]?.method, 'session.loadTranscriptPage');
  assert.deepEqual(requests[0]?.params, {
    sessionPath: '/workspace/idle.jsonl', direction: 'newer', loadedStart: 0, loadedEnd: 4,
  });

  await server.handleWorkerSessionControl(
    frame('message', { sessionPath: '/workspace/idle.jsonl', text: 'please continue' }),
    '/workspace/current.jsonl',
  );
  assert.equal(requests[1]?.method, 'message.send');
  assert.deepEqual(requests[1]?.params, {
    sessionPath: '/workspace/idle.jsonl', text: 'please continue', inputs: [],
    operationId: 'agent-session:control-message', operationAttempt: 1, localId: 'agent-session:control-message',
  });
});

test('session-control read pages older and newer rows relative to the caller cursor', async () => {
  const server = serverForTests();
  server.listSessionSummaries = async () => summaries;
  const totalCount = 250;
  const transcript = Array.from({ length: totalCount }, (_, index) => ({
    id: `row-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    markdown: `row ${index}`,
    status: 'completed' as const,
  }));
  server.handleRequest = async (request) => {
    if (request.method !== 'session.loadTranscriptPage') return { accepted: true };
    const params = request.params as {
      direction: 'older' | 'newer' | 'latest';
      loadedStart?: number;
      loadedEnd?: number;
    };
    const start = params.direction === 'latest'
      ? totalCount - 60
      : params.direction === 'older'
        ? Math.max(0, (params.loadedStart ?? 0) - 120)
        : (params.loadedStart ?? 0);
    const end = params.direction === 'latest'
      ? totalCount
      : params.direction === 'older'
        ? Math.min(totalCount, params.loadedEnd ?? totalCount)
        : Math.min(totalCount, (params.loadedEnd ?? 0) + 120);
    return {
      sessionPath: '/workspace/idle.jsonl',
      transcript: transcript.slice(start, end),
      transcriptWindow: {
        totalCount,
        loadedStart: start,
        loadedEnd: end,
        hasOlder: start > 0,
        hasNewer: end < totalCount,
        isPartial: start > 0 || end < totalCount,
        hasUserMessages: true,
      },
      busy: false,
    } satisfies TranscriptPagePayload;
  };

  const latest = await server.handleWorkerSessionControl(
    frame('read', { sessionPath: '/workspace/idle.jsonl', direction: 'latest', limit: 1 }),
    '/workspace/current.jsonl',
  );
  assert.deepEqual((latest.result.transcript as Array<{ id: string }>).map((row) => row.id), ['row-249']);
  assert.deepEqual(latest.result.cursor, { start: 249, end: 250 });

  const newestAtEnd = await server.handleWorkerSessionControl(
    frame('read', {
      sessionPath: '/workspace/idle.jsonl', direction: 'newer', cursor: latest.result.cursor, limit: 1,
    }),
    '/workspace/current.jsonl',
  );
  assert.deepEqual(newestAtEnd.result.transcript, []);
  assert.deepEqual(newestAtEnd.result.cursor, { start: 250, end: 250 });

  let olderCursor = latest.result.cursor;
  const olderIds: string[] = [];
  for (let page = 0; page < 3; page += 1) {
    const result = await server.handleWorkerSessionControl(
      frame('read', {
        sessionPath: '/workspace/idle.jsonl', direction: 'older', cursor: olderCursor, limit: 1,
      }),
      '/workspace/current.jsonl',
    );
    olderIds.push(...(result.result.transcript as Array<{ id: string }>).map((row) => row.id));
    olderCursor = result.result.cursor as { start: number; end: number };
  }
  assert.deepEqual(olderIds, ['row-248', 'row-247', 'row-246']);

  let newerCursor = { start: 0, end: 1 };
  const newerIds: string[] = [];
  for (let page = 0; page < 3; page += 1) {
    const result = await server.handleWorkerSessionControl(
      frame('read', {
        sessionPath: '/workspace/idle.jsonl', direction: 'newer', cursor: newerCursor, limit: 1,
      }),
      '/workspace/current.jsonl',
    );
    newerIds.push(...(result.result.transcript as Array<{ id: string }>).map((row) => row.id));
    newerCursor = result.result.cursor as { start: number; end: number };
  }
  assert.deepEqual(newerIds, ['row-1', 'row-2', 'row-3']);
});

test('private session close acknowledges lifecycle before scheduling existing forget cleanup', async () => {
  const server = serverForTests();
  server.listSessionSummaries = async () => summaries;
  const order: string[] = [];
  server.handleRequest = async (request) => {
    order.push(request.method);
    return { ok: true };
  };
  const close = await server.handleWorkerSessionControl(
    frame('close', { sessionPath: '/workspace/current.jsonl', delete: true }),
    '/workspace/current.jsonl',
  );
  assert.equal(close.result.deletion, 'scheduled');
  assert.deepEqual(order, ['session.lifecycleClose']);
  await close.afterResponse?.();
  assert.deepEqual(order, ['session.lifecycleClose', 'session.forget']);
});
