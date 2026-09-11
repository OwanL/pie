import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [{ AnalyticsRecorderSupervisor }, { AnalyticsQueryClient }] = await Promise.all([
  import('../../../src/analytics/recorder-supervisor.ts'),
  import('../../../src/analytics/query-client.ts'),
]);
const workerScript = fileURLToPath(new URL('./recorder-supervisor-lifecycle-worker.cjs', import.meta.url));
const queryWorkerScript = fileURLToPath(new URL('./query-client-worker.cjs', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-parent-flags-'));
const supervisor = new AnalyticsRecorderSupervisor({
  enabled: true,
  workerScript,
  databasePath: path.join(root, 'require-empty-exec-argv.log'),
});

let failure;
try {
  await supervisor.start();
  await supervisor.shutdown();
  const queryClient = new AnalyticsQueryClient({
    databasePath: path.join(root, 'require-owned-exec-argv.sqlite'),
    workerScript: queryWorkerScript,
  });
  const result = await queryClient.query({ type: 'schema' });
  if (result?.ok !== true) throw new Error('Query worker did not return its expected result.');
} catch (error) {
  failure = error;
} finally {
  try {
    await supervisor.shutdown();
  } catch (error) {
    failure ??= error;
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
}
if (failure !== undefined) throw failure;
