import test from 'node:test';
import assert from 'node:assert/strict';

import { BackendServer } from '../../../src/backend/server';
import type { SessionContext } from '../../../src/backend/server-types';
import { installAutonomousModeToolGuard } from '../../../src/backend/system-prompts';

interface ServerAutonomousTestPort {
  autonomousMode: boolean;
  sessionContexts: Map<string, SessionContext>;
  setAutonomousMode(enabled: boolean): void;
}

test('BackendServer removes ask_user from every live provider schema and restores only its own removal', () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/repo' }) as unknown as ServerAutonomousTestPort;
  let activeTools = ['read', 'ask_user', 'bash'];
  let promptTools = [...activeTools];
  const session = {
    getActiveToolNames: () => [...activeTools],
    getAllTools: () => [
      { name: 'read' },
      { name: 'ask_user' },
      { name: 'bash' },
    ],
    setActiveToolsByName(names: string[]) {
      activeTools = [...names];
      // The real SDK synchronously rebuilds the base prompt from this same
      // selected-tool list. Mirror that contract so the assertion covers both
      // provider schemas and tool prompt entries.
      promptTools = [...names];
    },
  };
  installAutonomousModeToolGuard(session, () => server.autonomousMode);

  const context = {
    runtime: { dispose: async () => undefined },
    session,
    sessionPath: '/repo/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
  } as unknown as SessionContext;
  server.sessionContexts.set(context.sessionPath, context);

  server.setAutonomousMode(true);
  assert.deepEqual(activeTools, ['read', 'bash']);
  assert.deepEqual(promptTools, ['read', 'bash']);
  assert.equal(context.autonomousModeAskUserWasActive, true);

  // A later extension update cannot re-expose the tool while the mode is on.
  session.setActiveToolsByName(['read', 'ask_user', 'bash']);
  assert.deepEqual(activeTools, ['read', 'bash']);

  server.setAutonomousMode(false);
  assert.deepEqual(activeTools, ['read', 'bash', 'ask_user']);
  assert.deepEqual(promptTools, ['read', 'bash', 'ask_user']);
  assert.equal(context.autonomousModeAskUserWasActive, undefined);
});

test('BackendServer restores ask_user when Tools is toggled off and back on during autonomous mode', () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/repo' }) as unknown as ServerAutonomousTestPort;
  let activeTools: string[] = [];
  const session = {
    getActiveToolNames: () => [...activeTools],
    getAllTools: () => [{ name: 'read' }, { name: 'ask_user' }, { name: 'bash' }],
    setActiveToolsByName: (names: string[]) => { activeTools = [...names]; },
  };
  installAutonomousModeToolGuard(session, () => server.autonomousMode);
  const context = {
    runtime: { dispose: async () => undefined },
    session,
    sessionPath: '/repo/tools-toggle.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    systemPromptDisabledEntries: ['tools'],
    systemPromptToolsBeforeDisable: ['read', 'ask_user', 'bash'],
  } as unknown as SessionContext;
  server.sessionContexts.set(context.sessionPath, context);

  server.setAutonomousMode(true);
  assert.equal(context.autonomousModeAskUserWasActive, true);

  // Mirrors re-enabling Tools: the system-prompt toggle restores its captured
  // selection, while the autonomous guard still strips ask_user.
  context.systemPromptDisabledEntries = [];
  session.setActiveToolsByName(context.systemPromptToolsBeforeDisable ?? []);
  context.systemPromptToolsBeforeDisable = undefined;
  assert.deepEqual(activeTools, ['read', 'bash']);

  server.setAutonomousMode(false);
  assert.deepEqual(activeTools, ['read', 'bash', 'ask_user']);
});

test('BackendServer does not enable ask_user when another owner had already hidden it', () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/repo' }) as unknown as ServerAutonomousTestPort;
  let activeTools = ['read', 'bash'];
  const session = {
    getActiveToolNames: () => [...activeTools],
    getAllTools: () => [{ name: 'read' }, { name: 'ask_user' }, { name: 'bash' }],
    setActiveToolsByName: (names: string[]) => { activeTools = [...names]; },
  };
  installAutonomousModeToolGuard(session, () => server.autonomousMode);
  const context = {
    runtime: { dispose: async () => undefined },
    session,
    sessionPath: '/repo/already-hidden.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
  } as unknown as SessionContext;
  server.sessionContexts.set(context.sessionPath, context);

  server.setAutonomousMode(true);
  server.setAutonomousMode(false);
  assert.deepEqual(activeTools, ['read', 'bash']);
});
