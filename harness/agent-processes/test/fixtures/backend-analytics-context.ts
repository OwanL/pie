import path from 'node:path';
import type { AnalyticsBackendContext } from '../../../../analytics/authority/backend-analytics-context.js';
import { PIE_BUILD_ID } from '../../../../lib/build-identity.js';
import { SessionLifecycleStore } from '../../../session-storage/lifecycle/session-lifecycle-store.js';

/** Real lifecycle authority confined to a caller-owned temporary fixture root. */
export function createBackendAnalyticsFixture(root: string) {
  const previousDataDir = process.env.PIE_DATA_DIR;
  process.env.PIE_DATA_DIR = path.join(root, 'runtime-data');
  const context: AnalyticsBackendContext = {
    mode: 'canonical-only', generationId: 'test-capture', buildId: PIE_BUILD_ID,
    workspaceId: 'test-workspace', hostInstanceId: 'test-host',
  };
  const store = new SessionLifecycleStore(path.join(process.env.PIE_DATA_DIR, 'state', 'session-lifecycle.sqlite'));
  store.registerAnalyticsHost({ hostInstanceId: context.hostInstanceId, workspaceId: context.workspaceId,
    generationId: context.hostInstanceId, buildId: PIE_BUILD_ID, processId: process.pid,
    capabilities: [], registeredAtMs: String(Date.now()) });
  return {
    context,
    hostPid: process.pid,
    close() {
      store.close();
      if (previousDataDir === undefined) delete process.env.PIE_DATA_DIR;
      else process.env.PIE_DATA_DIR = previousDataDir;
    },
  };
}
