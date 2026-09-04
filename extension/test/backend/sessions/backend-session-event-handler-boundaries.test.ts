import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  handleSdkSessionEvent,
  SDK_SESSION_EVENT_TYPES,
  type BackendSessionEventHandlerDeps,
} from '../../../src/backend/session-event-handler';
import { CONTENT_TOOL_SDK_EVENT_HANDLERS } from '../../../src/backend/session-event-content-tool';
import { LIFECYCLE_SDK_EVENT_HANDLERS } from '../../../src/backend/session-event-lifecycle';
import type { SdkSessionEvent } from '../../../src/backend/sdk';
import type { SessionContext } from '../../../src/backend/server-types';

const EXPECTED_CONTENT_TOOL_EVENTS = [
  'message_start',
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'message_end',
] as const;

const EXPECTED_LIFECYCLE_EVENTS = [
  'agent_start',
  'turn_start',
  'agent_end',
  'agent_settled',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'turn_end',
] as const;

const EXPECTED_SDK_EVENT_ORDER = [
  'agent_start',
  'turn_start',
  'message_start',
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'message_end',
  'agent_end',
  'agent_settled',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'turn_end',
] as const;

const backendSourceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/backend',
);

async function readBackendSource(fileName: string): Promise<string> {
  return await fs.readFile(path.join(backendSourceDir, fileName), 'utf8');
}

function createContext(): SessionContext {
  return {
    runtime: {} as SessionContext['runtime'],
    session: {} as SessionContext['session'],
    sessionPath: '/workspace/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
  };
}

function createDeps() {
  const observations: Array<{ kind: string; payload?: unknown }> = [];
  const deps: BackendSessionEventHandlerDeps = {
    emit(kind, payload) {
      observations.push({ kind, payload });
    },
    emitBusyChanged(_context, busy, capabilities) {
      observations.push({ kind: 'busy', payload: { busy, capabilities } });
    },
    emitContextUsageChanged(_context, estimatedTokens) {
      observations.push({ kind: 'context', payload: estimatedTokens });
    },
    async emitSessionOpened(sessionPath) {
      observations.push({ kind: 'opened', payload: sessionPath });
    },
    async emitSessionListChanged() {
      observations.push({ kind: 'list' });
    },
    recoverStuckSession(_context, reason) {
      observations.push({ kind: 'recover', payload: reason });
    },
  };
  return { deps, observations };
}

test('session-event domain catalogs preserve exact dispatch membership and SDK order', () => {
  assert.deepEqual(Object.keys(CONTENT_TOOL_SDK_EVENT_HANDLERS), EXPECTED_CONTENT_TOOL_EVENTS);
  assert.deepEqual(Object.keys(LIFECYCLE_SDK_EVENT_HANDLERS), EXPECTED_LIFECYCLE_EVENTS);
  assert.deepEqual(SDK_SESSION_EVENT_TYPES, EXPECTED_SDK_EVENT_ORDER);

  const catalog = [
    ...Object.keys(CONTENT_TOOL_SDK_EVENT_HANDLERS),
    ...Object.keys(LIFECYCLE_SDK_EVENT_HANDLERS),
  ];
  assert.equal(new Set(catalog).size, EXPECTED_SDK_EVENT_ORDER.length);
  assert.deepEqual([...catalog].sort(), [...EXPECTED_SDK_EVENT_ORDER].sort());
});

test('handleSdkSessionEvent dispatches every SDK event to its owning domain in parity order', async () => {
  const facade = await readBackendSource('session-event-handler.ts');
  const dispatches = [...facade.matchAll(
    /case '([^']+)':\s+return (CONTENT_TOOL|LIFECYCLE)_SDK_EVENT_HANDLERS\.([a-z_]+)\(/g,
  )].map((match) => ({ event: match[1], domain: match[2], handler: match[3] }));

  assert.deepEqual(dispatches, EXPECTED_SDK_EVENT_ORDER.map((event) => ({
    event,
    domain: (EXPECTED_CONTENT_TOOL_EVENTS as readonly string[]).includes(event)
      ? 'CONTENT_TOOL'
      : 'LIFECYCLE',
    handler: event,
  })));

  const representativeEvents: SdkSessionEvent[] = EXPECTED_SDK_EVENT_ORDER.map((type) => ({
    type,
    ...(type.startsWith('compaction_') ? { reason: 'threshold' as const } : {}),
  }));
  const originalNow = Date.now;
  Date.now = () => 1_750_000_000_000;
  try {
    for (const event of representativeEvents) {
      const facadeContext = createContext();
      const directContext = createContext();
      const facadeCapture = createDeps();
      const directCapture = createDeps();
      handleSdkSessionEvent(facadeCapture.deps, facadeContext, event);
      const directHandler = Object.hasOwn(CONTENT_TOOL_SDK_EVENT_HANDLERS, event.type)
        ? CONTENT_TOOL_SDK_EVENT_HANDLERS[event.type as keyof typeof CONTENT_TOOL_SDK_EVENT_HANDLERS]
        : LIFECYCLE_SDK_EVENT_HANDLERS[event.type as keyof typeof LIFECYCLE_SDK_EVENT_HANDLERS];
      directHandler(directCapture.deps, directContext, event);

      assert.deepEqual(facadeCapture.observations, directCapture.observations, event.type);
      assert.equal(facadeContext.compactionStartedAt, directContext.compactionStartedAt, event.type);
      assert.equal(facadeContext.activeRequest, directContext.activeRequest, event.type);
    }
  } finally {
    Date.now = originalNow;
  }
});

test('session-event facade retains tracing and dispatch while domain modules stay acyclic', async () => {
  const [facade, shared, contentTool, lifecycle] = await Promise.all([
    readBackendSource('session-event-handler.ts'),
    readBackendSource('session-event-shared.ts'),
    readBackendSource('session-event-content-tool.ts'),
    readBackendSource('session-event-lifecycle.ts'),
  ]);

  assert.match(facade, /export function handleSdkSessionEvent/);
  assert.match(facade, /stage: 'sdk\.observed'/);
  assert.match(facade, /CONTENT_TOOL_SDK_EVENT_HANDLERS/);
  assert.match(facade, /LIFECYCLE_SDK_EVENT_HANDLERS/);
  assert.doesNotMatch(facade, /function (?:armWillRetryWatchdog|boundToolProgress|appendCompactionMetricsSidecar)/);

  assert.doesNotMatch(shared, /session-event-(?:content-tool|lifecycle)/);
  assert.doesNotMatch(contentTool, /session-event-lifecycle/);
  assert.doesNotMatch(lifecycle, /session-event-content-tool/);
  assert.doesNotMatch(contentTool, /case '(?:agent_settled|compaction_start|auto_retry_start)'/);
  assert.doesNotMatch(lifecycle, /case '(?:message_update|tool_execution_start|message_end)'/);
});
