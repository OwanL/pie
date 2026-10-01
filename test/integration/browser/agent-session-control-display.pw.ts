// Playwright-only spec; .pw.ts is excluded from node:test discovery.
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, test } from './ui-smoke-fixtures.js';
import { reducer, createInitialArchState } from '../../../application/backend/conversation-state/reducer.js';
import { resolveSessionOpenedTranscript } from '../../../application/backend/transcript-delivery/session-opened-transcript.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ChatMessage, TranscriptWindow } from '../../../application/lib/protocol/index.js';
import {
  createSessionControlSender,
  sessionControlPromptPrefix,
} from '../../../harness/agent-processes/lib/rpc/session-control-attribution.js';
import { AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY } from '../../../harness/agent-processes/workers/agent-message-provenance.js';
import { mapTranscript, type SessionEntryLike } from '../../../harness/session-storage/transcripts/transcript.js';

const sessionPath = '/workspace/disposable-recipient-session.jsonl';
const sender = createSessionControlSender({ sessionId: 'disposable-coordinator', identityFallback: false }, 'Display fixture coordinator');
const senderPrefix = sessionControlPromptPrefix(sender);
if (!senderPrefix) throw new Error('Synthetic coordinator sender did not validate');
const scenarios = [
  { localId: 'local:agent-session:direct', text: 'Direct agent instruction after reload', status: 'completed' as const, timestamp: 1_790_000_000_000 },
  { localId: 'local:agent-session:queued', text: 'Queued agent follow-up after reload', status: 'queued' as const, timestamp: 1_790_000_000_001 },
];

function localRows(): ChatMessage[] {
  let state = createInitialArchState();
  for (const message of scenarios) {
    state = reducer(state, { kind: 'AgentMessageReceived', sessionPath, ...message, sender }).state;
  }
  return state.transcript.bySession[sessionPath] ?? [];
}

function durableEntry(scenario: typeof scenarios[number], id: string): SessionEntryLike {
  const timestamp = scenario.timestamp;
  const message = {
    role: 'user' as const,
    content: `${senderPrefix}${scenario.text}`,
    timestamp,
    [AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY]: { sender },
  };
  return {
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    type: 'message',
    message: message as NonNullable<SessionEntryLike['message']>,
  };
}

async function assertAgentRows(page: import('@playwright/test').Page): Promise<void> {
  const userRows = page.locator('.message-item-shell[data-role="user"]');
  await expect(userRows).toHaveCount(2);
  const ids = await userRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')));
  expect(new Set(ids).size).toBe(2);
  for (const scenario of scenarios) {
    const row = userRows.filter({ hasText: scenario.text });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.session-tab-agent-icon')).toHaveCount(1);
    await expect(row).toContainText('Agent');
    await expect(row).toContainText(sender.title!);
  }
  await expect(page.locator('body')).not.toContainText('[Pie cross-session sender identity:');
  await expect(page.locator('body')).not.toContainText('pie-reply:v1:');
}

const incomingWindow: TranscriptWindow = {
  ...EMPTY_VIEW_STATE.transcriptWindow,
  totalCount: 1,
  loadedEnd: 1,
  hasUserMessages: true,
};
const localWindow: TranscriptWindow = { ...incomingWindow, totalCount: 2, loadedEnd: 2 };
const originalOptimisticRows = localRows();
const mappedIncoming = mapTranscript([durableEntry(scenarios[0]!, 'sdk-direct-agent-user')]);
const opened = resolveSessionOpenedTranscript({
  busy: true,
  incomingTranscript: mappedIncoming,
  incomingTranscriptWindow: incomingWindow,
  localTranscript: originalOptimisticRows,
  localTranscriptWindow: localWindow,
});
const deliveredIncomingWindow: TranscriptWindow = { ...incomingWindow, totalCount: 2, loadedEnd: 2 };
const idleOpened = resolveSessionOpenedTranscript({
  busy: false,
  incomingTranscript: mapTranscript([
    durableEntry(scenarios[0]!, 'sdk-direct-agent-user'),
    durableEntry(scenarios[1]!, 'sdk-queued-agent-user'),
  ]),
  incomingTranscriptWindow: deliveredIncomingWindow,
  localTranscript: originalOptimisticRows,
  localTranscriptWindow: localWindow,
});

test.describe('agent session-control transcript rows in isolated built Preact UI', () => {
  test.use({
    viewState: {
      transcript: opened.transcript,
      transcriptWindow: opened.transcriptWindow,
    },
  });

  test('renders durable direct and queued rows once after reload at phone and tablet widths', async ({ page, isolatedHost }) => {
    expect(opened.transcript.map((message) => message.markdown)).toEqual(scenarios.map(({ text }) => text));
    expect(opened.transcript.map((message) => message.customType)).toEqual(['agent-message', 'agent-message']);
    expect(opened.transcript[0]?.id).toBe('sdk-direct-agent-user');
    expect(opened.transcript[1]?.status).toBe('queued');

    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'pie-agent-session-control-display-'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(isolatedHost.url);
    await assertAgentRows(page);
    await page.reload();
    await assertAgentRows(page);
    await page.screenshot({ path: path.join(evidenceDir, '390px.png'), fullPage: true });

    await page.setViewportSize({ width: 800, height: 900 });
    await assertAgentRows(page);
    await page.screenshot({ path: path.join(evidenceDir, '800px.png'), fullPage: true });
    console.log(`Agent session-control visual evidence: ${evidenceDir}`);
  });
});

test.describe('delivered queued agent rows in isolated built Preact UI', () => {
  test.use({
    viewState: {
      transcript: idleOpened.transcript,
      transcriptWindow: idleOpened.transcriptWindow,
    },
  });

  test('does not duplicate durable direct and queued rows after reload when idle', async ({ page, isolatedHost }) => {
    expect(idleOpened.preserveLocal).toBe(false);
    expect(idleOpened.transcript.map((message) => message.id)).toEqual(['sdk-direct-agent-user', 'sdk-queued-agent-user']);
    expect(idleOpened.transcript.map((message) => message.markdown)).toEqual(scenarios.map(({ text }) => text));
    expect(idleOpened.transcript.map((message) => message.customType)).toEqual(['agent-message', 'agent-message']);

    await page.goto(isolatedHost.url);
    await assertAgentRows(page);
    await page.reload();
    await assertAgentRows(page);
  });
});
