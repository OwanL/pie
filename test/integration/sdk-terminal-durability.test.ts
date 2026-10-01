import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { loadSdk } from '../../harness/agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../harness/agent-processes/lib/sdk-integration/test/source-fixture.js';
import { mapTranscript } from '../../harness/session-storage/transcripts/transcript';

const artifactVerifierUrl = new URL('../../lib/pi-runtime/artifact.mjs', import.meta.url).href;

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sdk-terminal-durability-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('fresh SDK reopen retains terminal entries when the writer exits before publication', {
  skip: process.env.PIE_RUN_INTEGRATION_TESTS === '1'
    ? false
    : 'run npm run test:integration to exercise cross-process SDK durability',
}, async () => {
  await withTempDir(async (tempDir) => {
    const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode);
    const sdkModuleUrl = pathToFileURL(path.join(sourceDescriptor.sdkPath, 'dist', 'core', 'session-manager.js')).href;
    const cwd = path.join(tempDir, 'workspace');
    const sessions = path.join(tempDir, 'sessions');
    const handoff = path.join(tempDir, 'handoff.json');
    await fs.mkdir(cwd, { recursive: true });

    const childScript = String.raw`
      import fs from 'node:fs';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [sdkUrl, cwd, sessions, handoff, verifierUrl, serializedDescriptor] = process.argv.slice(1);
      const { verifyPiRuntimeArtifact } = await import(verifierUrl);
      const descriptor = JSON.parse(serializedDescriptor);
      const verified = await verifyPiRuntimeArtifact(descriptor.artifactDir, {
        target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
      });
      if (verified.identity !== descriptor.identity || verified.sdkPath !== descriptor.sdkPath
        || sdkUrl !== pathToFileURL(path.join(verified.sdkPath, 'dist/core/session-manager.js')).href) {
        throw new Error('Writer SDK descriptor disagreement');
      }
      const { SessionManager } = await import(sdkUrl);
      const manager = SessionManager.create(cwd, sessions);
      const assistantId = manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-durable', name: 'read', arguments: { path: 'safe' } }],
        timestamp: Date.now(),
        api: 'test', provider: 'test', model: 'test',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse'
      });
      const toolResultId = manager.appendMessage({
        role: 'toolResult', toolCallId: 'tool-durable', toolName: 'read',
        content: [{ type: 'text', text: 'ok' }], details: { ok: true }, isError: false,
        timestamp: Date.now()
      });
      fs.writeFileSync(handoff, JSON.stringify({
        sessionFile: manager.getSessionFile(), assistantId, toolResultId
      }));
      // Simulate process loss after durable append but before a public terminal
      // notification could cross the backend transport.
      process.exit(86);
    `;

    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', childScript, sdkModuleUrl, cwd, sessions, handoff,
        artifactVerifierUrl, JSON.stringify(sourceDescriptor)],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(child.status, 86, child.stderr || child.stdout);

    const evidence = JSON.parse(await fs.readFile(handoff, 'utf8')) as {
      sessionFile: string;
      assistantId: string;
      toolResultId: string;
    };
    const reopened = sdk.SessionManager.open(evidence.sessionFile);
    const transcript = mapTranscript(reopened.getBranch() as any);
    const assistant = transcript.find((message) => message.role === 'assistant');

    assert.equal(assistant?.durableEntryId, evidence.assistantId);
    assert.equal(assistant?.toolCalls?.[0]?.durableEntryId, evidence.toolResultId);
    assert.equal(assistant?.toolCalls?.[0]?.status, 'completed');
  });
});
