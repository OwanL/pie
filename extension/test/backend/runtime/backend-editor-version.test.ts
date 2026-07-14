import test from 'node:test';
import assert from 'node:assert/strict';

import { BackendServer } from '../../../src/backend/index';

test('backend passes editor version to SDK services for IDE auth headers', async () => {
  const previousEditorVersion = process.env.PIE_EDITOR_VERSION;
  process.env.PIE_EDITOR_VERSION = '1.102.3-test';

  try {
    const serviceOptions: unknown[] = [];
    const server = new BackendServer({ sdkPath: '/unused', cwd: '/workspace' }) as any;
    server.agentDir = '/agent';
    server.authStorage = { kind: 'auth-storage' };
    server.sdk = {
      createAgentSessionServices: async (options: unknown) => {
        serviceOptions.push(options);
        return { modelRegistry: { getAvailable: () => [], find: () => undefined } };
      },
      createAgentSessionFromServices: async ({ services, sessionManager }: any) => ({
        services,
        session: {
          isStreaming: false,
          messages: [],
          sessionManager,
          subscribe: () => () => undefined,
        },
      }),
    };

    const factory = server.createRuntimeFactory();
    await factory({
      cwd: '/workspace',
      agentDir: '/agent',
      sessionManager: { getCwd: () => '/workspace' },
    });

    assert.equal((serviceOptions[0] as { editorVersion?: string }).editorVersion, '1.102.3-test');
  } finally {
    if (previousEditorVersion === undefined) {
      delete process.env.PIE_EDITOR_VERSION;
    } else {
      process.env.PIE_EDITOR_VERSION = previousEditorVersion;
    }
  }
});