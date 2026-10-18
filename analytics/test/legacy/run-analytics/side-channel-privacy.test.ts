import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { forgetGlobalSideChannelsForStorageDirs } from '../../../legacy/run-analytics/side-channel';

test('side-channel privacy scrubs all rotations and identities while preserving unrelated and malformed lines', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-side-channel-privacy-'));
  try {
    await fs.mkdir(path.join(root, 'data'));
    const retained = ['{malformed', 'null', '[]', JSON.stringify({ sessionId: 'other' })];
    const raw = [
      JSON.stringify({ sessionId: 'private-id' }),
      JSON.stringify({ rootSessionId: 'private-id' }),
      JSON.stringify({ sessionId: '/private/session.jsonl' }),
      JSON.stringify({ sessionPath: '/private/session.jsonl' }),
      ...retained,
      '',
    ].join('\r\n');
    const files = ['pruning.jsonl', 'tool-result-pruning.jsonl', 'warm-bash.jsonl']
      .flatMap((name) => ['', '.1', '.2'].map((suffix) => path.join(root, 'data', name + suffix)));
    await Promise.all(files.map((file) => fs.writeFile(file, raw)));
    await forgetGlobalSideChannelsForStorageDirs([
      path.join(root, 'data', 'outcomes', 'workspace-a'),
      path.join(root, 'data', 'outcomes', 'workspace-b'),
    ], '/private/session.jsonl', 'private-id');
    for (const file of files) assert.equal(await fs.readFile(file, 'utf8'), retained.join('\n') + '\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('side-channel privacy ignores missing files but propagates real read failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-side-channel-errors-'));
  try {
    await forgetGlobalSideChannelsForStorageDirs([root], '/private/session.jsonl');
    await fs.mkdir(path.join(root, 'data', 'pruning.jsonl'), { recursive: true });
    await assert.rejects(forgetGlobalSideChannelsForStorageDirs([root], '/private/session.jsonl'),
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
