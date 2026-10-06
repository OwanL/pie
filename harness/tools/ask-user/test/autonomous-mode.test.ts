import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import registerAskUser from '../index.js';

const ENV = 'PIE_AUTONOMOUS_MODE';
const TOGGLES = 'PIE_EXTENSION_TOGGLES_JSON';

function fixture(t: TestContext, initial = ['read', 'ask_user']) {
  const previous = { [ENV]: process.env[ENV], [TOGGLES]: process.env[TOGGLES] };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env[ENV] = '0';
  delete process.env[TOGGLES];
  let active = [...initial];
  let configured = ['read', 'ask_user'];
  let beforeStart!: () => void;
  let tool!: { execute: (...args: any[]) => Promise<any> };
  const applied: string[][] = [];
  registerAskUser({
    on(event: string, handler: () => void) { if (event === 'before_agent_start') beforeStart = handler; },
    registerTool(definition: typeof tool) { tool = definition; },
    getActiveTools: () => [...active],
    getAllTools: () => configured.map((name) => ({ name })),
    setActiveTools(names: string[]) { active = [...names]; applied.push([...names]); },
  } as any);
  return { tool, beforeStart, applied, active: () => active,
    setActive: (names: string[]) => { active = names; },
    setConfigured: (names: string[]) => { configured = names; } };
}

test('malformed toggles fail open and normal execution delegates to UI with call identity and signal', async (t) => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  for (const toggle of ['{broken', 'null', '{"ask-user":true}']) {
    process.env[TOGGLES] = toggle;
    const calls: unknown[][] = [];
    const result = await f.tool.execute('call-normal', { question: 'Which?', options: ['A', 'B'], allowCustom: false },
      signal, undefined, { ui: {
        select: async (...args: unknown[]) => { calls.push(args); return 'B'; },
        input: async () => { assert.fail('preset answer should not request free text'); },
      } });
    assert.deepEqual(calls, [['Which?', ['A', 'B'], { signal, allowCustom: false, toolCallId: 'call-normal' }]]);
    assert.deepEqual(result.details, { answer: 'B', source: 'option', cancelled: false });
    assert.equal(result.isError, false);
  }
});

test('disabled toggle blocks UI and does not restore an autonomously removed tool', async (t) => {
  const f = fixture(t);
  process.env[ENV] = '1';
  f.beforeStart();
  process.env[ENV] = '0';
  process.env[TOGGLES] = '{"ask-user":false}';
  f.beforeStart();
  assert.deepEqual(f.active(), ['read']);
  const result = await f.tool.execute('disabled', {}, undefined, undefined, { ui: {
    select: async () => { assert.fail('disabled tool must not invoke UI'); },
  } });
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { disabled: true });
  delete process.env[TOGGLES];
  f.beforeStart();
  assert.deepEqual(f.active(), ['read'], 'reenabling must not override the now-inactive tool selection');
});

test('manual inactivity is preserved in both autonomous and normal sessions', (t) => {
  const f = fixture(t, ['read']);
  f.beforeStart();
  process.env[ENV] = '1';
  f.beforeStart();
  f.beforeStart();
  process.env[ENV] = '0';
  f.beforeStart();
  assert.deepEqual(f.active(), ['read']);
  assert.deepEqual(f.applied, []);
});

test('restoration neither revives an unregistered tool nor duplicates an already active one', (t) => {
  const f = fixture(t);
  process.env[ENV] = '1';
  f.beforeStart();
  f.setConfigured(['read']);
  process.env[ENV] = '0';
  f.beforeStart();
  assert.deepEqual(f.active(), ['read']);
  f.setConfigured(['read', 'ask_user']);
  f.setActive(['read', 'ask_user']);
  process.env[ENV] = '1';
  f.beforeStart();
  f.setActive(['read', 'ask_user']);
  process.env[ENV] = '0';
  f.beforeStart();
  assert.deepEqual(f.active(), ['read', 'ask_user']);
  assert.deepEqual(f.applied, [['read'], ['read']], 'no redundant restoration writes');
});

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
