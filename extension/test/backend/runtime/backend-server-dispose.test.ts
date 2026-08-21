import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { ColdSessionLeaseAuthority } from '../../../src/backend/cold-session-store';

test('BackendServer disposal retires cold leases after later backend generations', async () => {
  const leases = new ColdSessionLeaseAuthority(7);
  const server = new BackendServer({
    sdkPath: '/sdk',
    cwd: '/workspace',
    workerEntryPath: '/worker-entry.js',
    backendGeneration: 7,
  }) as unknown as {
    coldSessionStore: { leases: ColdSessionLeaseAuthority };
    dispose(): Promise<void>;
  };
  server.coldSessionStore = { leases };

  await server.dispose();

  assert.equal(leases.coordinatorGeneration, 8);
});
