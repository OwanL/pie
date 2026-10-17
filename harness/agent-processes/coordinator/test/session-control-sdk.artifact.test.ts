import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { verifyPiRuntimeArtifact } from '../../../../lib/pi-runtime/artifact.mjs';
import { createSessionControlTool } from '../../../tools/session-control/index.js';
import { createBackendTools } from '../backend-tools.js';

// Run the selected compiled SDK's real tool executor, without provider calls.
// The SDK-free fixture's catch wrapper cannot prove the model sees isError.
async function sdk() {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, 'requires test:file --sdk-path pointing at the staged SDK');
  const entry = JSON.parse(readFileSync(config, 'utf8')).compilerOptions?.paths?.['@earendil-works/pi-coding-agent']?.[0];
  assert.ok(entry && path.isAbsolute(entry), 'missing staged SDK alias');
  const sdkRoot = path.resolve(path.dirname(entry), '..');
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, '../../..'));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot, 'requires aliases from a verified artifact, not workspace output');
  const scope = path.dirname(sdkRoot);
  const importExport = async (name: string, subpath = '.') => {
    const packageFile = path.join(scope, name.split('/')[1], 'package.json');
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
    const target = manifest.exports[subpath].import;
    assert.equal(typeof target, 'string', `${name} must declare an import export`);
    return import(new URL(target, pathToFileURL(packageFile)).href);
  };
  const agent = await importExport('@earendil-works/pi-agent-core');
  const ai = await importExport('@earendil-works/pi-ai', './compat');
  return { ...agent, ...ai };
}

async function execute(tool: ReturnType<typeof createSessionControlTool>, args: unknown) {
  const { Agent, EventStream, getModel } = await sdk();
  let turn = 0;
  const agent = new Agent({
    initialState: { model: getModel('openai', 'gpt-4o'), tools: [tool] },
    streamFn: () => {
      const stream = new EventStream((event: any) => event.type === 'done', (event: any) => event.message);
      const message = {
        role: 'assistant', content: turn++ === 0
          ? [{ type: 'toolCall', id: 'control', name: 'session_control', arguments: args }]
          : [{ type: 'text', text: 'done' }],
        api: 'openai-completions', provider: 'openai', model: 'gpt-4o',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: turn === 1 ? 'toolUse' : 'stop', timestamp: Date.now(),
      };
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  await agent.prompt('exercise session control');
  const result = agent.state.messages.find((message: any) => message.role === 'toolResult');
  assert.ok(result, 'real SDK must publish a tool result');
  return result;
}

test('real SDK publishes bridge and partial-outcome failures as model-visible tool errors', async () => {
  for (const response of [
    { kind: 'session.control.result', requestId: 'r', ok: false, error: { code: 'SESSION_CONTROL_FAILED', message: 'known rejection', retryable: false } },
    { kind: 'session.control.result', requestId: 'r', ok: true, result: { message: { status: 'unknown' } } },
  ]) {
    const result = await execute(createSessionControlTool(async () => response as never), { action: 'message', title: 'Target', prompt: 'body' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /session_control error:/u);
  }
});

test('real SDK executes child reads but cannot send child mutations to IPC', async () => {
  const calls: unknown[] = [];
  const tools = createBackendTools({ kind: 'subagent', requestSessionControl: async body => {
    calls.push(body);
    return { kind: 'session.control.result', requestId: 'r', ok: true, result: { transcript: [] } };
  } });
  const tool = tools.find(tool => tool.name === 'session_control')!;
  assert.equal((await execute(tool, { action: 'read', self: true })).isError, false);
  assert.equal(calls.length, 1);
  calls.length = 0;
  assert.equal((await execute(tool, { action: 'cleanup' })).isError, true);
  assert.deepEqual(calls, []);
});
