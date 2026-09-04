#!/usr/bin/env node
/**
 * Mock PI backend.
 *
 * Simulates the minimal subset of the PI backend protocol used in integration
 * tests:
 *   - Emits `backend.ready` on startup.
 *   - Responds to `app.ping`, `session.list`, `session.open`, and `message.send`.
 *   - After `message.send`, emits a minimal streaming sequence:
 *       message.started → message.delta × 2 → tool.started → tool.finished → message.finished
 *   - Emits `busy.changed` around the streaming sequence.
 *   - Exits cleanly after receiving `test.shutdown` or after 5 seconds of inactivity.
 */

import * as readline from 'node:readline';

const SESSION_PATH = '/mock/sessions/test-session.jsonl';
const SESSION_NAME = 'Test Session';
const CWD = '/mock';
const PROTOCOL_VERSION = 15;
const IDLE_CAPABILITIES = { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true };
const BUSY_CAPABILITIES = { billableActivity: true, canContinue: false, canInterrupt: true, canCompact: false };
const HANDSHAKE = {
  sdkPath: '/mock/sdk',
  agentDir: '/mock/agent',
  sdkVersion: '0.0.0-mock',
  protocolVersion: PROTOCOL_VERSION,
  authPath: '/mock/agent/auth.json',
};

let seq = 0;

function emit(event, payload) {
  process.stdout.write(JSON.stringify({ event, payload }) + '\n');
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ id, ok: false, error: { code, message } }) + '\n');
}

// Emit backend.ready immediately.
emit('backend.ready', HANDSHAKE);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const inactivityTimer = setTimeout(() => process.exit(0), 5000);

rl.on('line', (line) => {
  clearTimeout(inactivityTimer);
  // Reset inactivity timer on each line
  inactivityTimer.refresh();

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case 'app.ping':
      respond(id, HANDSHAKE);
      break;

    case 'runtimePrefs.set':
      respond(id, params ?? {});
      break;

    case 'session.list':
      respond(id, {
        sessions: [{
          path: SESSION_PATH,
          name: SESSION_NAME,
          cwd: CWD,
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
          isPlaceholder: false,
        }],
      });
      break;

    case 'session.open': {
      const sessionPath = params?.path ?? SESSION_PATH;
      respond(id, { ok: true });
      emit('session.opened', {
        session: {
          path: sessionPath,
          name: SESSION_NAME,
          cwd: CWD,
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
          isPlaceholder: false,
        },
        transcript: [],
        transcriptWindow: {
          totalCount: 0,
          loadedStart: 0,
          loadedEnd: 0,
          hasOlder: false,
          hasNewer: false,
          isPartial: false,
          hasUserMessages: false,
        },
        busy: false,
        capabilities: IDLE_CAPABILITIES,
        systemPrompts: [
          {
            source: 'provider',
            title: 'Provider system prompt',
            text: 'Unknown.\n\nThe upstream provider prompt is not exposed to this extension.',
            summary: 'Unknown',
            availability: 'unknown',
          },
          {
            source: 'harness',
            title: 'Harness system prompt',
            text: 'The PI runtime does not expose its built-in harness prompt text.',
            summary: 'PI prompt not exposed',
            availability: 'hidden',
          },
          {
            source: 'user',
            title: 'User system prompt',
            text: 'You are a helpful assistant.',
            summary: 'You are a helpful assistant.',
            availability: 'available',
          },
        ],
        analyticsFactors: {
          promptFamily: 'harness+customPrompt+selectedTools+skills',
          promptHash: 'mock-prompt-hash',
          promptCapturedAt: '2025-06-15T10:30:00.000Z',
          harnessPromptHash: 'mock-harness-hash',
          customPromptHash: 'mock-custom-hash',
          appendSystemPromptHash: null,
          promptGuidelineHashes: ['mock-guideline-hash'],
          contextFiles: [{ path: '/mock/context.md', hash: 'mock-context-hash' }],
          selectedToolIds: ['read', 'bash'],
          toolSnippetHashes: [{ toolId: 'bash', hash: 'mock-tool-snippet-hash' }],
          toolSetHash: 'mock-tool-set-hash',
          skills: [{
            name: 'frontend-design',
            contentHash: 'mock-skill-hash',
            sourceHash: 'mock-skill-source-hash',
            disableModelInvocation: false,
          }],
          skillSetHash: 'mock-skill-set-hash',
        },
        modelSettings: { defaultModel: 'claude-mock', defaultThinkingLevel: 'medium' },
        availableModels: [{
          id: 'claude-mock',
          name: 'Claude Mock',
          provider: 'mock',
          reasoning: true,
          inputKinds: ['text', 'image'],
          contextWindow: 200000,
          maxTokens: 8192,
        }],
        contextUsage: {
          tokens: 64000,
          contextWindow: 200000,
          percent: 32,
        },
      });
      break;
    }

    case 'message.send': {
      const requestId = params?.requestId ?? 'rq-mock-1';
      const messageId = 'msg-mock-1';
      const toolCallId = 'tc-mock-1';
      const sessionPath = params?.sessionPath ?? SESSION_PATH;

      respond(id, { requestId });

      // Busy on
      seq += 1;
      emit('busy.changed', { sessionPath, busy: true, capabilities: BUSY_CAPABILITIES, seq });
      emit('contextUsage.changed', {
        sessionPath,
        contextUsage: {
          tokens: 64100,
          contextWindow: 200000,
          percent: 32.05,
        },
      });

      // Stream sequence (async to give test time to read)
      setTimeout(() => {
        emit('message.started', {
          requestId,
          messageId,
          sessionPath,
          modelId: 'claude-mock',
          thinkingLevel: 'medium',
        });

        setTimeout(() => {
          emit('message.delta', { requestId, messageId, sessionPath, delta: 'Hello' });
          emit('contextUsage.changed', {
            sessionPath,
            contextUsage: {
              tokens: 64250,
              contextWindow: 200000,
              percent: 32.125,
            },
          });

          setTimeout(() => {
            emit('message.delta', { requestId, messageId, sessionPath, delta: ', world!' });

            setTimeout(() => {
              emit('tool.started', { requestId, messageId, toolCallId, sessionPath, name: 'read_file', input: { path: '/mock/file.ts' } });
              emit('contextUsage.changed', {
                sessionPath,
                contextUsage: {
                  tokens: 64500,
                  contextWindow: 200000,
                  percent: 32.25,
                },
              });

              setTimeout(() => {
                emit('tool.finished', { requestId, messageId, toolCallId, sessionPath, result: 'const x = 1;', status: 'completed' });

                setTimeout(() => {
                  emit('message.finished', {
                    requestId,
                    sessionPath,
                    message: {
                      id: messageId,
                      role: 'assistant',
                      createdAt: new Date().toISOString(),
                      markdown: 'Hello, world!',
                      modelId: 'claude-mock',
                      thinkingLevel: 'medium',
                      status: 'completed',
                      toolCalls: [{
                        id: toolCallId,
                        name: 'read_file',
                        input: { path: '/mock/file.ts' },
                        result: 'const x = 1;',
                        status: 'completed',
                      }],
                    },
                  });
                  emit('contextUsage.changed', {
                    sessionPath,
                    contextUsage: {
                      tokens: 64800,
                      contextWindow: 200000,
                      percent: 32.4,
                    },
                  });

                  // Busy off
                  seq += 1;
                  emit('busy.changed', { sessionPath, busy: false, capabilities: IDLE_CAPABILITIES, seq });
                }, 10);
              }, 10);
            }, 10);
          }, 10);
        }, 10);
      }, 10);
      break;
    }

    case 'message.interrupt':
      respond(id, { ok: true });
      seq += 1;
      emit('contextUsage.changed', {
        sessionPath: params?.sessionPath ?? SESSION_PATH,
        contextUsage: {
          tokens: 64800,
          contextWindow: 200000,
          percent: 32.4,
        },
      });
      emit('busy.changed', { sessionPath: params?.sessionPath ?? SESSION_PATH, busy: false, capabilities: IDLE_CAPABILITIES, seq });
      break;

    case 'test.shutdown':
      respond(id, { ok: true });
      setTimeout(() => process.exit(0), 50);
      break;

    default:
      respondError(id, 'METHOD_NOT_FOUND', `Unknown method: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
