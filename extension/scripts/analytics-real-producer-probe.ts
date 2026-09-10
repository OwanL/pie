import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { deserialize } from 'node:v8';

import { captureSubagentTerminalResult } from '../../extensions/subagent/src/analytics-capture.js';

const body = 'real nested terminal body '.repeat(80_000);
const terminal: any = {
  childId: 'child-terminal',
  attemptId: 'attempt-failover-2',
  agent: 'worker',
  agentSource: 'project',
  task: 'retain nested terminal evidence',
  exitCode: 0,
  stderr: '',
  usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 30, turns: 1 },
  stopReason: 'completed',
  attempts: [
    { attemptId: 'attempt-failover-1', status: 'failed', error: 'provider unavailable' },
    { attemptId: 'attempt-failover-2', status: 'completed' },
  ],
  messages: [{
    role: 'toolResult',
    toolCallId: 'nested-tool',
    toolName: 'subagent',
    content: [{ type: 'text', text: 'nested complete' }],
    details: {
      results: [{
        childId: 'grandchild',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: body }] }],
        OPENAI_API_KEY: 'sk-must-not-cross-boundary',
      }],
    },
  }],
};
let captured: any;
let acknowledgementResolved = false;
const config: any = {
  generationId: 'real-producer-generation',
  captureSubject: { kind: 'session', rootSessionId: 'real-producer-root' },
  sink: {
    submitDetail: (capture: unknown) => {
      captured = capture;
      setTimeout(() => { acknowledgementResolved = true; }, 300);
    },
  },
};
const started = performance.now();
const status = captureSubagentTerminalResult(terminal, config, 'parent-tool');
const handoffMs = performance.now() - started;
assert.equal(status, 'submitted');
assert.equal(acknowledgementResolved, false, 'producer must not wait for recorder acknowledgement');
const detached = deserialize(Buffer.from(captured.bytes));
assert.equal(detached.messages[0].details.results[0].messages[0].content[0].text, body);
assert.equal(detached.messages[0].details.results[0].OPENAI_API_KEY, '[redacted]');
terminal.messages[0].details.results[0].messages[0].content[0].text = 'mutated-after-teardown';
assert.equal(deserialize(Buffer.from(captured.bytes)).messages[0].details.results[0].messages[0].content[0].text, body);

const rejectionStarted = performance.now();
const rejectionStatus = captureSubagentTerminalResult(terminal, {
  ...config,
  sink: { submitDetail: () => { throw new Error('bounded capacity'); } },
}, 'parent-tool');
const rejectionHandoffMs = performance.now() - rejectionStarted;
assert.equal(rejectionStatus, 'rejected');

console.log(JSON.stringify({
  source: 'extensions/subagent/src/analytics-capture.ts',
  status,
  handoffMs,
  detachedBytes: captured.bytes.byteLength,
  nestedDepth: 2,
  failoverAttemptsRetained: detached.attempts.length,
  cancellationOrCapacityStatus: rejectionStatus,
  rejectionHandoffMs,
  delayedAcknowledgementDidNotGate: true,
  mutationAfterHandoffDidNotAlterCapture: true,
  credentialFilteredBeforeSerialization: true,
}));
