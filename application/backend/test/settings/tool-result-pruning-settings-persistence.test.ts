import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPersistedToolResultPruningSettings as load, saveToolResultPruningSettings as save } from '../../settings/tool-result-pruning-settings-persistence';
import { DEFAULT_TOOL_RESULT_PRUNING_SETTINGS as defaults, type ToolResultPruningSettings } from '../../../lib/protocol/index.js';

for (const canonical of [false, true]) {
  test(`tool-result settings normalize and persist (${canonical ? 'canonical' : 'stored'})`, async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const dir = mkdtempSync(path.join(tmpdir(), 'pie-tool-result-settings-'));
    try {
      if (canonical) process.env.PI_CODING_AGENT_DIR = dir;
      else delete process.env.PI_CODING_AGENT_DIR;
      const stale = { enabled: false, rules: { ansi: false } } as ToolResultPruningSettings;
      let value = stale;
      const events: string[] = [];
      const storage = { get: () => value, update: (next: ToolResultPruningSettings) => { events.push('mirror'); value = next; } };
      const expected = { ...defaults, enabled: false, rules: { ...defaults.rules, ansi: false }, tools: null };
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ toolResultPruning: stale }));
      await load(storage, (next) => { events.push('dispatch'); assert.deepEqual(next, expected); });
      assert.deepEqual(events, canonical ? ['dispatch', 'mirror'] : ['dispatch']);
      const errors: string[] = [];
      await save(storage, () => expected, { tools: ['bash'] }, (message) => errors.push(message));
      assert.deepEqual(value, { ...expected, tools: ['bash'] });
      if (canonical) {
        assert.deepEqual(errors, []);
        assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).toolResultPruning.tools, ['bash']);
      } else {
        assert.match(errors[0]!, /^Failed to update tool-result pruning settings: PI_CODING_AGENT_DIR is not set/);
      }
      // A host mirror failure must propagate, not become a canonical-write notice.
      const failure = new Error('mirror unavailable');
      await assert.rejects(save({ get: () => value, update: () => { throw failure; } }, () => value, {}), failure);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('load mirror rejection falls back after canonical dispatch', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-tool-result-mirror-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    writeFileSync(path.join(dir, 'settings.json'), '{}');
    const events: string[] = [];
    const values: ToolResultPruningSettings[] = [];
    await load({
      get: () => { events.push('get'); return { ...defaults, enabled: false }; },
      update: async () => { events.push('mirror'); throw new Error('mirror unavailable'); },
    }, (value) => { events.push('dispatch'); values.push(value); });
    assert.deepEqual(events, ['dispatch', 'mirror', 'get', 'dispatch']);
    assert.deepEqual(values, [defaults, { ...defaults, enabled: false }]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
