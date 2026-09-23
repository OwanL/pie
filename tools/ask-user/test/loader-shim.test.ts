import assert from 'node:assert/strict';
import test from 'node:test';

import registerImplementation from '../index.js';
import registerDiscoveryShim from '../../../extensions/ask-user/index.js';

test('ask-user discovery shim re-exports the single implementation registrar', () => {
  assert.equal(registerDiscoveryShim, registerImplementation);

  const toolNames: string[] = [];
  const events: string[] = [];
  registerDiscoveryShim({
    on(event: string) { events.push(event); },
    registerTool(tool: { name: string }) { toolNames.push(tool.name); },
  } as any);

  assert.deepEqual(toolNames, ['ask_user']);
  assert.deepEqual(events, ['before_agent_start']);
});
