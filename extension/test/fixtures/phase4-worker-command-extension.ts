import * as fs from 'node:fs';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

interface FixtureCommandOptions {
  action: 'new' | 'switch' | 'fork';
  resultPath: string;
  switchPath?: string;
}

interface WritableSessionManager {
  getSessionFile(): string | undefined;
  getEntries(): Array<{ id: string; type: string }>;
  appendCustomEntry(customType: string, data?: unknown): string;
}

function writableManager(context: { sessionManager: unknown }): WritableSessionManager {
  return context.sessionManager as WritableSessionManager;
}

function record(kind: string, context: { sessionManager: { getSessionFile(): string | undefined } }, detail?: unknown): void {
  const tracePath = process.env.PIE_PHASE4_EXTENSION_FIXTURE_TRACE;
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify({
    kind,
    sessionPath: context.sessionManager.getSessionFile(),
    detail,
  })}\n`);
}

function completeReplacement(
  resultPath: string,
  action: FixtureCommandOptions['action'],
  sourcePath: string,
  destinationContext: { sessionManager: unknown },
): void {
  const manager = writableManager(destinationContext);
  const finalPath = manager.getSessionFile();
  if (!finalPath) throw new Error(`Phase 4 fixture ${action} destination has no session path.`);
  manager.appendCustomEntry(
    action === 'fork' ? 'phase4-extension-durable' : `phase4-extension-${action}`,
    { action, sourcePath, finalPath },
  );
  fs.writeFileSync(resultPath, JSON.stringify({ action, sourcePath, finalPath }));
  record('command_destination', { sessionManager: manager }, action);
}

export default function phase4WorkerCommandExtension(pi: ExtensionAPI): void {
  pi.registerCommand('phase4-no-agent', {
    description: 'Complete an extension command without starting an agent turn.',
    handler: async (encodedResultPath, context) => {
      const resultPath = Buffer.from(encodedResultPath, 'base64url').toString('utf8');
      const manager = writableManager(context);
      const sessionPath = manager.getSessionFile();
      if (!sessionPath || !resultPath) throw new Error('Phase 4 no-agent fixture arguments are incomplete.');
      record('command_no_agent', context);
      manager.appendCustomEntry('phase4-extension-no-agent', { sessionPath });
      fs.writeFileSync(resultPath, JSON.stringify({ sessionPath }));
    },
  });

  pi.on('session_start', (event, context) => {
    record('session_start', context, event.reason);
    pi.appendEntry('phase4-extension-bound', { reason: event.reason });
  });
  pi.on('session_shutdown', (event, context) => {
    record('session_shutdown', context, event.reason);
  });

  pi.registerCommand('phase4-replace', {
    description: 'Exercise worker-owned session replacement through extension command dispatch.',
    handler: async (encodedArgs, context) => {
      const options = JSON.parse(Buffer.from(encodedArgs, 'base64url').toString('utf8')) as FixtureCommandOptions;
      if (!options.action || !options.resultPath) throw new Error('Phase 4 fixture command arguments are incomplete.');
      await context.waitForIdle();
      const manager = writableManager(context);
      const sourcePath = manager.getSessionFile();
      if (!sourcePath) throw new Error('Phase 4 fixture command source has no session path.');
      record('command_start', context, options.action);

      if (options.action === 'new') {
        const result = await context.newSession({
          setup: async (replacementManager) => {
            (replacementManager as unknown as WritableSessionManager)
              .appendCustomEntry('phase4-new-setup', { durable: true });
          },
          withSession: async (replacementContext) => {
            completeReplacement(options.resultPath, options.action, sourcePath, replacementContext);
          },
        });
        if (result.cancelled) throw new Error('Phase 4 fixture new-session action was cancelled.');
        return;
      }

      if (options.action === 'switch') {
        if (!options.switchPath) throw new Error('Phase 4 fixture switch action requires switchPath.');
        const result = await context.switchSession(options.switchPath, {
          withSession: async (replacementContext) => {
            completeReplacement(options.resultPath, options.action, sourcePath, replacementContext);
          },
        });
        if (result.cancelled) throw new Error('Phase 4 fixture switch action was cancelled.');
        return;
      }

      const forkEntry = manager.getEntries().find((entry) => entry.type === 'custom');
      if (!forkEntry) throw new Error('Phase 4 fixture fork source has no durable entry.');
      const result = await context.fork(forkEntry.id, {
        position: 'at',
        withSession: async (replacementContext) => {
          completeReplacement(options.resultPath, options.action, sourcePath, replacementContext);
        },
      });
      if (result.cancelled) throw new Error('Phase 4 fixture fork was cancelled.');
    },
  });
}
