import test from 'node:test';
import assert from 'node:assert/strict';

import registerAskUser from '../index.js';

const ENV = 'PIE_AUTONOMOUS_MODE';

test('ask-user removes itself in autonomous sessions, restores afterward, and refuses stale calls', async (t) => {
  const previous = process.env[ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  });

  let active = ['read', 'ask_user'];
  let beforeAgentStart: (() => void) | undefined;
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  const applied: string[][] = [];
  const pi = {
    on(event: string, handler: () => void) {
      if (event === 'before_agent_start') beforeAgentStart = handler;
    },
    registerTool(definition: typeof tool) { tool = definition; },
    getActiveTools: () => [...active],
    getAllTools: () => [{ name: 'read' }, { name: 'ask_user' }],
    setActiveTools(names: string[]) {
      active = [...names];
      applied.push([...names]);
    },
  };

  registerAskUser(pi as any);
  assert.ok(beforeAgentStart);
  assert.ok(tool);

  process.env[ENV] = '1';
  beforeAgentStart!();
  assert.deepEqual(active, ['read']);
  assert.deepEqual(applied, [['read']]);

  const blocked = await tool!.execute('call-1', {}, undefined, undefined, { ui: {} });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.details.autonomousMode, true);

  process.env[ENV] = '0';
  beforeAgentStart!();
  assert.deepEqual(active, ['read', 'ask_user']);
});
