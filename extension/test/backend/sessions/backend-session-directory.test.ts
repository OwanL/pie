import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import type { SessionContext } from '../../../src/backend/server-types';

type PollingTestServer = {
  agentDir: string;
  sessionDir: string;
  sessionDirResolved: boolean;
  sessionCatalog: {
    invalidateIfInventoryChanged(agentDir: string, sessionDir?: string): Promise<boolean>;
  };
  emitSessionListChanged(): Promise<void>;
  startSessionCatalogPolling(intervalMs?: number): void;
  sessionCatalogPollTimer?: NodeJS.Timeout;
  pollSessionCatalog(): Promise<void>;
  dispose(): Promise<void>;
};

function createPollingTestServer(): PollingTestServer {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/workspace' }) as unknown as PollingTestServer;
  server.agentDir = path.resolve('/agent');
  server.sessionDir = path.resolve('/configured/sessions');
  server.sessionDirResolved = true;
  return server;
}

test('backend RPCs use the configured directory while explicit legacy opens keep their path', async () => {
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  const configuredDir = path.resolve('/configured/sessions');
  const sdkFallbackDir = path.resolve('/sdk-default/sessions');
  process.env.PI_CODING_AGENT_SESSION_DIR = configuredDir;

  try {
    const listedDirs: Array<string | undefined> = [];
    const openCalls: unknown[][] = [];
    const server = new BackendServer({ sdkPath: '/unused', cwd: '/workspace' }) as any;
    server.agentDir = path.resolve('/agent');
    server.sdk = {
      VERSION: 'test',
      SessionManager: {
        create: (cwd: string, sessionDir?: string) => ({
          cwd,
          sessionPath: path.join(sessionDir ?? sdkFallbackDir, 'created.jsonl'),
        }),
        listAll: async (sessionDir?: string) => {
          listedDirs.push(sessionDir);
          return [];
        },
        open: (...args: unknown[]) => {
          openCalls.push(args);
          return { cwd: '/legacy-workspace', sessionPath: String(args[0]) };
        },
      },
    };
    server.createSessionContext = async (manager: { cwd: string; sessionPath: string }) => ({
      sessionPath: manager.sessionPath,
      busySeq: 0,
      unsubscribe: () => undefined,
      session: { isStreaming: false },
    }) as SessionContext;
    server.buildSessionOpenedPayload = async (sessionPath: string) => ({ sessionPath });
    server.emit = () => undefined;
    server.emitBusyChanged = () => undefined;
    server.emitSessionListChanged = async () => undefined;

    const result = await server.handleRequest({
      id: 'create-configured',
      method: 'session.create',
      params: { cwd: '/workspace' },
    }) as { sessionPath: string };

    assert.equal(result.sessionPath, path.join(configuredDir, 'created.jsonl'));

    assert.deepEqual(await server.handleRequest({ id: 'list-configured', method: 'session.list' }), []);
    assert.deepEqual(listedDirs, [configuredDir, undefined]);
    assert.deepEqual(await server.handleRequest({ id: 'list-cached', method: 'session.list' }), []);
    assert.deepEqual(listedDirs, [configuredDir, undefined], 'unchanged catalog must not rescan session files');

    const legacyPath = path.join(sdkFallbackDir, 'legacy.jsonl');
    const opened = await server.handleRequest({
      id: 'open-legacy',
      method: 'session.open',
      params: { sessionPath: legacyPath },
    }) as { sessionPath: string };
    assert.equal(opened.sessionPath, legacyPath);
    assert.deepEqual(openCalls, [[legacyPath]]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  }
});

test('session inventory polling is unrefed, overlap-safe, emits once, and stops on dispose', async () => {
  const server = createPollingTestServer();

  let checks = 0;
  let resolveCheck: ((changed: boolean) => void) | undefined;
  server.sessionCatalog.invalidateIfInventoryChanged = async () => {
    checks += 1;
    return await new Promise<boolean>((resolve) => { resolveCheck = resolve; });
  };
  let emissions = 0;
  server.emitSessionListChanged = async () => { emissions += 1; };

  server.startSessionCatalogPolling(60_000);
  const timer = server.sessionCatalogPollTimer as NodeJS.Timeout;
  assert.equal(timer.hasRef(), false, 'background inventory polling must not keep the backend alive');

  const first = server.pollSessionCatalog();
  const overlapping = server.pollSessionCatalog();
  assert.equal(checks, 1, 'an overlapping tick must reuse/skip the active inventory check');
  resolveCheck?.(true);
  await Promise.all([first, overlapping]);
  assert.equal(emissions, 1, 'one changed inventory emits one session-list refresh');

  await server.dispose();
  await server.pollSessionCatalog();
  assert.equal(checks, 1, 'disposed polling cannot start another inventory check');
});

test('session inventory polling emits no list refresh when inventory inspection fails', async () => {
  const server = createPollingTestServer();
  server.sessionCatalog.invalidateIfInventoryChanged = async () => {
    throw Object.assign(new Error('inventory unavailable'), { code: 'EACCES' });
  };
  let emissions = 0;
  server.emitSessionListChanged = async () => { emissions += 1; };

  server.startSessionCatalogPolling(60_000);
  await server.pollSessionCatalog();
  assert.equal(emissions, 0, 'a failed inventory read cannot publish a possibly truncated list');
  await server.dispose();
});
