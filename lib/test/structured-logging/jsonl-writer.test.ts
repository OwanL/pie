import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonlWriter } from '../../structured-logging/jsonl-writer.js';

test('JsonlWriter appends through repeated rotation failures and recovers rotation later', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pie-jsonl-writer-test-'));
  const logPath = path.join(directory, 'events.jsonl');
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    const writer = new JsonlWriter({
      defaultLogPath: logPath,
      warnLabel: '[test] failed to append log',
      maxBytes: 1,
    });
    await writeFile(logPath, '{"event":"initial"}\n', 'utf8');
    await mkdir(`${logPath}.2`);
    await writeFile(path.join(`${logPath}.2`, 'blocks-rotation'), 'fixture', 'utf8');

    writer.append('{"event":"during-failure-1"}');
    writer.append('{"event":"during-failure-2"}');
    await writer.flush();

    assert.deepEqual(
      (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
      [
        { event: 'initial' },
        { event: 'during-failure-1' },
        { event: 'during-failure-2' },
      ],
      'both appends should reach the active file in order despite rotation failures',
    );
    assert.equal(warnings.length, 2, 'each failed rotation should warn');
    assert.ok(warnings.every(([message]) => String(message).includes('failed to rotate')));
    assert.ok(warnings.every(([message]) => !String(message).includes('failed to append')));

    await rm(`${logPath}.2`, { recursive: true });
    writer.append('{"event":"after-recovery"}');
    await writer.flush();

    assert.equal(await readFile(`${logPath}.1`, 'utf8'), '{"event":"initial"}\n{"event":"during-failure-1"}\n{"event":"during-failure-2"}\n');
    assert.equal(await readFile(logPath, 'utf8'), '{"event":"after-recovery"}\n');
    assert.equal(warnings.length, 2, 'successful recovery should not warn');
  } finally {
    console.warn = originalWarn;
    await rm(directory, { recursive: true, force: true });
  }
});
