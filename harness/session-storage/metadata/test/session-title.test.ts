import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendAdmissionFallbackMarker, getAdmissionFallbackTitle } from '../session-title';
import { readIndexedSessionMetadata } from '../session-metadata';
import { statBackendSessionFile } from '../../catalog/session-directory';

test('fallback marker persists and same-name manual assignment invalidates it', async () => {
  const entries: unknown[] = [{ type: 'session_info', id: 'title-1', name: 'Review' }];
  const manager = {
    getEntries: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); },
  };
  appendAdmissionFallbackMarker(manager);
  assert.equal(getAdmissionFallbackTitle(manager), 'Review');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-title-marker-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    await fs.writeFile(file, [{ type: 'session', id: 'session', cwd: '/repo' }, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const initial = await readIndexedSessionMetadata((await statBackendSessionFile(file))!);
    assert.equal(initial.status, 'ok');
    if (initial.status !== 'ok') return;
    assert.equal(initial.metadata.summary.isAdmissionFallback, true);
    assert.equal(initial.metadata.summary.isAssignedTitle, true);
    const manual = { type: 'session_info', id: 'title-2', name: 'Review' };
    entries.push(manual);
    assert.equal(getAdmissionFallbackTitle(manager), undefined);
    await fs.appendFile(file, JSON.stringify(manual) + '\n');
    const updated = await readIndexedSessionMetadata((await statBackendSessionFile(file))!, initial.metadata);
    assert.equal(updated.status, 'ok');
    if (updated.status !== 'ok') return;
    assert.equal(updated.resumedAppend, true);
    assert.equal(updated.metadata.summary.isAdmissionFallback, undefined);
    assert.equal(updated.metadata.summary.name, 'Review');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('marker requires a durable latest title and writer', () => {
  assert.throws(() => appendAdmissionFallbackMarker({ getEntries: () => [] }));
  assert.throws(() => appendAdmissionFallbackMarker({ getEntries: () => [{ type: 'session_info', name: 'Review' }], appendCustomEntry: () => undefined }));
});
