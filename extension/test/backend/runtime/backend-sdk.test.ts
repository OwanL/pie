import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  applySdkRetryHotPatch,
  applySdkTerminalDurabilityPatch,
  loadSdk,
  loadSdkInternalModule,
} from '../../../src/backend/sdk';

const DURABILITY_PATCH_SOURCE = `
        // Notify all listeners
        this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
        // Handle session persistence
        if (event.type === "message_end") {
            if (event.message.role === "custom") {
                this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);
            }
            else if (event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult") {
                this.sessionManager.appendMessage(event.message);
            }
            // Other message types
        }
`;

async function withSdkDir(files: Record<string, string>, run: (sdkDir: string) => Promise<void>): Promise<void> {
  const sdkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sdk-contract-test-'));
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  process.env.PIE_TRUSTED_SDK_ROOT = sdkDir;
  try {
    await fs.writeFile(path.join(sdkDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(sdkDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, 'utf8');
    }
    await run(sdkDir);
  } finally {
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    await fs.rm(sdkDir, { recursive: true, force: true });
  }
}

test('loadSdk rejects disallowed paths before attempting to import', async () => {
  const testDir = path.parse(path.dirname(fileURLToPath(import.meta.url))).root;
  await assert.rejects(
    async () => await loadSdk(path.join(testDir, 'disallowed-pie-sdk')),
    /Refusing to load SDK from disallowed path/,
  );
});

test('applySdkRetryHotPatch extends the current pi-ai retry.js array shape for terminal-event cuts + provider-gate stalls', async () => {
  // Current SDK shape: the retryable pattern is a string array in
  // pi-ai/dist/utils/retry.js (joined into a RegExp). The needle is the
  // quoted array entry with trailing comma so it does not match the comment
  // line that also mentions `stream ended before message_stop`.
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const RETRYABLE = [
        "ended without",
        "stream ended before message_stop",
        "http2 request did not get a response",
      ];
      // Comment mentioning "stream ended before message_stop" without a trailing comma - must NOT be matched.
      export function isRetryableAssistantError(message) { return RETRYABLE.some(p => new RegExp(p, "i").test(message.errorMessage)); }
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    const patched = await fs.readFile(path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'), 'utf8');

    assert.equal(result, 'patched');
    // New array entries appended after the matched one.
    assert.match(patched, /"stream ended before message_stop", "stream ended before a terminal response event", "upstream stream stalled", "upstream header phase stalled", "upstream transport circuit open",/);
    // The comment line must be untouched (no trailing-comma needle injected there).
    assert.match(patched, /Comment mentioning "stream ended before message_stop" without/);
  });
});

test('applySdkRetryHotPatch extends the legacy inline agent-session.js classifier shape', async () => {
  // Legacy SDK shape: an inline regex in dist/core/agent-session.js.
  await withSdkDir({
    'dist/core/agent-session.js': `
      return /ended without|stream ended before message_stop|timeout/i.test(err);
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    const patched = await fs.readFile(path.join(sdkDir, 'dist', 'core', 'agent-session.js'), 'utf8');

    assert.equal(result, 'patched');
    assert.match(patched, /stream ended before message_stop\|stream ended before a terminal response event\|upstream stream stalled\|upstream header phase stalled\|upstream transport circuit open/);
  });
});

test('applySdkRetryHotPatch prefers the current pi-ai shape when both files exist', async () => {
  // Both shapes present (e.g. a transitional install): the current pi-ai
  // retry.js array shape is patched, the legacy agent-session.js untouched.
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["ended without", "stream ended before message_stop", "timeout"];
    `,
    'dist/core/agent-session.js': `
      return /stream ended before message_stop|timeout/i.test(err);
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'patched');
    const retryJs = await fs.readFile(path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'), 'utf8');
    const agentSession = await fs.readFile(path.join(sdkDir, 'dist', 'core', 'agent-session.js'), 'utf8');
    assert.match(retryJs, /stream ended before a terminal response event/);
    // Legacy file was NOT touched (no marker injected there).
    assert.doesNotMatch(agentSession, /stream ended before a terminal response event/);
  });
});

test('applySdkRetryHotPatch adds newly-required patterns to a previously patched SDK', async () => {
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["stream ended before message_stop", "stream ended before a terminal response event", "upstream stream stalled", "upstream header phase stalled", "timeout"];
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    const patched = await fs.readFile(path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'), 'utf8');
    assert.equal(result, 'patched');
    assert.match(patched, /upstream transport circuit open/);
  });
});

test('applySdkRetryHotPatch is a no-op when every required pattern is present', async () => {
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["stream ended before message_stop", "stream ended before a terminal response event", "upstream stream stalled", "upstream header phase stalled", "upstream transport circuit open", "timeout"];
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'already-present');
  });
});

test('applySdkRetryHotPatch falls back to legacy shape when the pi-ai file is absent', async () => {
  // An older global npm install may only have the inline classifier.
  await withSdkDir({
    'dist/core/agent-session.js': `
      return /stream ended before message_stop|timeout/i.test(err);
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'patched');
  });
});

test('applySdkRetryHotPatch reports missing-target when no candidate file exists', async () => {
  await withSdkDir({}, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'missing-target');
  });
});

test('applySdkRetryHotPatch reports unsupported-shape when a candidate file exists but the needle is gone', async () => {
  // The classifier was restructured again (needle absent in both shapes).
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["totally different pattern"];
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'unsupported-shape');
  });
});

test('terminal durability patch publishes message_end only after append with stable entry id', async () => {
  await withSdkDir({ 'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE }, async (sdkDir) => {
    assert.equal(await applySdkTerminalDurabilityPatch(sdkDir), 'patched');
    const patched = await fs.readFile(path.join(sdkDir, 'dist', 'core', 'agent-session.js'), 'utf8');
    assert.match(patched, /event\.type !== "message_end"/u);
    assert.match(patched, /sessionEntryId = this\.sessionManager\.appendMessage/u);
    assert.match(patched, /this\._emit\(\{ \.\.\.emittedEvent, sessionEntryId \}\)/u);
    assert.equal(await applySdkTerminalDurabilityPatch(sdkDir), 'already-present');
  });
});

test('terminal durability patch fails closed on unsupported SDK shape', async () => {
  await withSdkDir({ 'dist/core/agent-session.js': 'class Changed {}' }, async (sdkDir) => {
    assert.equal(await applySdkTerminalDurabilityPatch(sdkDir), 'unsupported-shape');
  });
});

test('loadSdk imports allowed ESM SDK modules that satisfy the contract', async () => {
  await withSdkDir({
    'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE,
    'dist/index.js': `
      export const VERSION = 'test-sdk';
      export class AgentSession {
        _installAgentNextTurnRefresh() {}
        async _checkCompaction() { return false; }
      }
      export const getAgentDir = () => '/agent';
      export const AuthStorage = { create: (filePath) => ({ filePath }) };
      export const SessionManager = {
        listAll: async () => [],
        continueRecent: (cwd) => ({ cwd, getCwd: () => cwd, getSessionFile: () => undefined, getSessionName: () => undefined, getBranch: () => [], getEntries: () => [] }),
        create: (cwd) => ({ cwd, getCwd: () => cwd, getSessionFile: () => undefined, getSessionName: () => undefined, getBranch: () => [], getEntries: () => [] }),
        open: (sessionPath) => ({ getCwd: () => '/repo', getSessionFile: () => sessionPath, getSessionName: () => undefined, getBranch: () => [], getEntries: () => [] }),
      };
      export const createAgentSessionServices = async () => ({ services: true });
      export const createAgentSessionFromServices = async () => ({ session: true });
      export const createAgentSessionRuntime = async () => ({ session: { isStreaming: false }, services: { modelRegistry: { getAvailable: () => [], find: () => undefined } }, dispose: async () => {} });
    `,
    'dist/core/system-prompt.js': `export const buildSystemPrompt = (options) => JSON.stringify(options);`,
  }, async (sdkDir) => {
    const sdk = await loadSdk(sdkDir);
    const systemPromptModule = await loadSdkInternalModule<{ buildSystemPrompt: (options: unknown) => string }>(sdkDir, path.join('core', 'system-prompt.js'));

    assert.equal(sdk.VERSION, 'test-sdk');
    assert.equal(sdk.getAgentDir(), '/agent');
    assert.deepEqual(await sdk.SessionManager.listAll(), []);
    assert.equal(systemPromptModule.buildSystemPrompt({ cwd: '/repo' }), '{"cwd":"/repo"}');
  });
});

test('loadSdk rejects modules that are missing required exports', async () => {
  await withSdkDir({
    'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE,
    'dist/index.js': `export const VERSION = 'broken-sdk'; export const getAgentDir = () => '/agent';`,
  }, async (sdkDir) => {
    await assert.rejects(
      async () => await loadSdk(sdkDir),
      /missing required exports/,
    );
  });
});
