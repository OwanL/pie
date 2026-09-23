import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import registerDeferredTriggers from '../index.js';
import registerDiscoveryShim from '../../../extensions/deferred-triggers/index.js';

const TRIGGERS_DIR_ENV = 'PIE_TRIGGERS_DIR';

type Tool = { name: string; description: string; promptGuidelines: string[]; execute: (...args: unknown[]) => Promise<unknown> };
type ToolResult = { isError: boolean; content: Array<{ text: string }>; details?: any };

let tempDir: string;
let savedTriggersDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-deferred-trigger-tool-test-'));
  savedTriggersDir = process.env[TRIGGERS_DIR_ENV];
  process.env[TRIGGERS_DIR_ENV] = tempDir;
});

afterEach(() => {
  if (savedTriggersDir === undefined) delete process.env[TRIGGERS_DIR_ENV];
  else process.env[TRIGGERS_DIR_ENV] = savedTriggersDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function setup(): { tools: Record<string, Tool>; defs: Record<string, Tool> } {
  const tools: Record<string, Tool> = {};
  registerDeferredTriggers({
    registerTool(value: unknown) {
      const tool = value as Tool;
      tools[tool.name] = tool;
    },
  } as never);
  assert.ok(tools.defer_trigger);
  return { tools, defs: tools };
}

function context(session = 'session.jsonl', cwd = tempDir) {
  return {
    sessionManager: { getSessionFile: () => path.join(tempDir, session) },
    cwd,
    hasUI: false,
  };
}

function readSidecar(): any[] {
  const file = path.join(tempDir, 'triggers.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('deferred-triggers discovery shim preserves the implementation registrar', () => {
  assert.equal(registerDiscoveryShim, registerDeferredTriggers);
  const registered: string[] = [];
  registerDiscoveryShim({ registerTool: (tool: { name: string }) => registered.push(tool.name) } as never);
  assert.deepEqual(registered, ['defer_trigger']);
});

test('defer_trigger tool surface explains the persisted-session prerequisite concisely', () => {
  const { defs } = setup();
  const def = defs.defer_trigger;
  // First sentence stays a concise relevance summary (permanent prompt budget).
  const firstSentence = def.description.split('. ')[0];
  assert.ok(firstSentence.length <= 180, `first description sentence must stay within 180 characters (got ${firstSentence.length})`);
  assert.match(firstSentence, /Register, list, or cancel durable triggers/);
  // The persisted-session prerequisite must be stated on the always-on surface.
  assert.match(def.description, /persisted JSONL path/);
  assert.match(def.description, /in-memory subagent sessions/);
  assert.ok(def.promptGuidelines.some((guideline) => (
    guideline.startsWith('Every defer_trigger action')
    && guideline.includes('persisted JSONL path')
    && guideline.includes('in-memory subagent sessions')
  )));
});

test('defer_trigger registers a normalized wake without aborting the current turn', async () => {
  const { tools } = setup();
  const registrationCwd = path.join(tempDir, 'project');
  const result = await tools.defer_trigger.execute(
    'defer-call',
    {
      action: 'register',
      triggers: [{ kind: 'command', command: 'git status', cwd: '.' }],
      message: 'resume later',
    },
    undefined,
    undefined,
    context('caller.jsonl', registrationCwd),
  ) as ToolResult;

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Registered deferred trigger/);

  const [op] = readSidecar();
  assert.equal(op.op, 'register');
  assert.equal(op.message, 'resume later');
  assert.equal(op.sessionPath, path.join(tempDir, 'caller.jsonl'));
  assert.equal(op.targetSession, path.join(tempDir, 'caller.jsonl'));
  assert.equal(op.triggers[0].cwd, path.resolve(registrationCwd));
  assert.equal(op.triggers[0].intervalMs, 30_000);
  assert.equal(op.triggers[0].timeoutMs, 10_000);
});

test('register requires a message and never writes a partial registration', async () => {
  const { tools } = setup();
  const result = await tools.defer_trigger.execute(
    'defer-call',
    { action: 'register', triggers: [{ kind: 'timer', ms: 1_000 }] },
    undefined,
    undefined,
    context(),
  ) as ToolResult;

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /message is required/);
  assert.deepEqual(readSidecar(), []);
});

test('register persists an explicit target session without changing creator ownership', async () => {
  const { tools } = setup();
  const result = await tools.defer_trigger.execute(
    'defer-call',
    {
      action: 'register',
      triggers: [{ kind: 'user_input' }],
      message: 'tell the target to continue',
      targetSession: path.join(tempDir, 'target.jsonl'),
    },
    undefined,
    undefined,
    context('creator.jsonl'),
  ) as ToolResult;

  assert.equal(result.isError, false);
  const [op] = readSidecar();
  assert.equal(op.sessionPath, path.join(tempDir, 'creator.jsonl'));
  assert.equal(op.targetSession, path.join(tempDir, 'target.jsonl'));
});

test('command predicates are denied by safeguard before a wake is persisted', async () => {
  const { tools } = setup();
  const result = await tools.defer_trigger.execute(
    'defer-call',
    { action: 'register', triggers: [{ kind: 'command', command: 'rm -rf /' }], message: 'unsafe' },
    undefined,
    undefined,
    context(),
  ) as ToolResult;

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Safeguard/);
  assert.deepEqual(readSidecar(), []);
});

test('list and targeted cancel are restricted to the creator session', async () => {
  const { tools } = setup();
  const registered = await tools.defer_trigger.execute(
    'defer-call',
    { action: 'register', triggers: [{ kind: 'user_input' }], message: 'owned wake' },
    undefined,
    undefined,
    context('creator.jsonl'),
  ) as ToolResult;
  const id = registered.details.id as string;

  const foreignCancel = await tools.defer_trigger.execute(
    'cancel-call',
    { action: 'cancel', triggerId: id },
    undefined,
    undefined,
    context('other.jsonl'),
  ) as ToolResult;
  assert.equal(foreignCancel.isError, true);

  const listed = await tools.defer_trigger.execute(
    'list-call',
    { action: 'list' },
    undefined,
    undefined,
    context('creator.jsonl'),
  ) as ToolResult;
  assert.match(listed.content[0].text, new RegExp(id));

  const cancelled = await tools.defer_trigger.execute(
    'cancel-call',
    { action: 'cancel', triggerId: id },
    undefined,
    undefined,
    context('creator.jsonl'),
  ) as ToolResult;
  assert.equal(cancelled.isError, false);
  const after = await tools.defer_trigger.execute(
    'list-call',
    { action: 'list' },
    undefined,
    undefined,
    context('creator.jsonl'),
  ) as ToolResult;
  assert.match(after.content[0].text, /No pending deferred triggers/);
});
