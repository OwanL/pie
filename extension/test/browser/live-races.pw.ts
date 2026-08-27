// Playwright-only spec; the .pw.ts suffix keeps it out of pie's node:test discovery.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

const liveModelRun = process.env.npm_lifecycle_event === 'test:browser:live-model';
const allowedProviders = new Set(['ollama', 'openai-codex']);
const runStatePath = path.resolve(__dirname, '../../../data/overnight-stability/2026-08-24-luna-xhigh/run-state.json');
const finalSessionStatePath = path.resolve(__dirname, '../../../data/overnight-stability/2026-08-24-luna-xhigh/final-session.json');
let stabilitySessionPath: string | null = null;

interface Provenance {
  provider: string;
  model: string | null;
}

interface ChildProvenance {
  childId: string;
  agent: string;
  task: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  exitCode: number;
  costUsd: number;
}

interface BrowserSocketWindow extends Window {
  __pieTestSockets?: WebSocket[];
}

async function captureBrowserSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const socketWindow = window as BrowserSocketWindow;
    const NativeWebSocket = window.WebSocket;
    socketWindow.__pieTestSockets = [];
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        socketWindow.__pieTestSockets?.push(this);
      }
    }
    window.WebSocket = TrackedWebSocket;
  });
}

function collectProvenance(value: unknown, found: Provenance[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProvenance(item, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.provider === 'string') {
    const model = typeof record.model === 'string'
      ? record.model
      : typeof record.modelId === 'string' ? record.modelId : null;
    found.push({ provider: record.provider, model });
  }
  for (const child of Object.values(record)) collectProvenance(child, found);
}

function collectChildProvenance(value: unknown, found: ChildProvenance[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectChildProvenance(item, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === 'object'
    ? record.usage as Record<string, unknown>
    : null;
  if (
    typeof record.agent === 'string'
    && typeof record.task === 'string'
    && typeof record.provider === 'string'
    && typeof record.model === 'string'
    && typeof record.thinkingLevel === 'string'
    && typeof record.exitCode === 'number'
  ) {
    found.push({
      childId: typeof record.childId === 'string'
        ? record.childId
        : typeof record.attemptId === 'string' ? record.attemptId : `${record.agent}:${record.task}`,
      agent: record.agent,
      task: record.task,
      provider: record.provider,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      exitCode: record.exitCode,
      costUsd: typeof usage?.cost === 'number' ? usage.cost : 0,
    });
  }
  for (const child of Object.values(record)) collectChildProvenance(child, found);
}

async function sessionProvenance(sessionPath: string): Promise<Provenance[]> {
  const raw = await readFile(sessionPath, 'utf8');
  const found: Provenance[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    collectProvenance(JSON.parse(line) as unknown, found);
  }
  return found.filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.provider === entry.provider && candidate.model === entry.model) === index);
}

async function assertSessionProvenance(sessionPath: string): Promise<Provenance[]> {
  const provenance = await sessionProvenance(sessionPath);
  expect(provenance.length).toBeGreaterThan(0);
  expect(provenance.some((entry) => entry.provider === 'ollama' && entry.model === 'deepseek-v4-flash:0731-cloud')).toBe(true);
  expect(provenance.filter((entry) => !allowedProviders.has(entry.provider))).toEqual([]);
  return provenance;
}

async function sessionChildProvenance(sessionPath: string): Promise<ChildProvenance[]> {
  const raw = await readFile(sessionPath, 'utf8');
  const found: ChildProvenance[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    collectChildProvenance(JSON.parse(line) as unknown, found);
  }
  return found.filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.childId === entry.childId) === index);
}

async function assertProviderGate(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Model' })).toContainText('DeepSeek V4 Flash 0731');
  await expect(page.getByRole('button', { name: 'Reasoning level' })).toContainText('Max');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Providers' }).click();
  const providers = dialog.getByRole('tabpanel').getByRole('checkbox');
  for (let index = 0; index < await providers.count(); index += 1) {
    const checkbox = providers.nth(index);
    const provider = (await checkbox.textContent())?.trim() ?? '';
    const checked = await checkbox.getAttribute('aria-checked');
    expect(checked, `${provider} provider toggle`).toBe(String(allowedProviders.has(provider)));
  }
  await dialog.getByRole('tab', { name: 'Extensions' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Ask User', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('checkbox', { name: 'Subagent', exact: true })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: /Expand .*subagent.* settings/iu }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Always use parent model' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('checkbox', { name: 'Fallback on provider failure' })).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: 'Enable autonomous mode — run without the ask_user tool' }))
    .toHaveAttribute('aria-pressed', 'false');
}

async function activeSessionPath(page: Page): Promise<string> {
  const activeTab = page.locator('.session-tab.active[data-tab-path]');
  await expect(activeTab).toHaveCount(1);
  return await activeTab.getAttribute('data-tab-path') ?? '';
}

async function recordStabilitySessionPath(sessionPath: string): Promise<void> {
  stabilitySessionPath = sessionPath;
  await mkdir(path.dirname(runStatePath), { recursive: true });
  await writeFile(runStatePath, `${JSON.stringify({ sessionPath }, null, 2)}\n`, 'utf8');
}

async function loadStabilitySessionPath(): Promise<string> {
  if (stabilitySessionPath) return stabilitySessionPath;
  const state = JSON.parse(await readFile(runStatePath, 'utf8')) as { sessionPath?: unknown };
  if (typeof state.sessionPath !== 'string' || !state.sessionPath.endsWith('.jsonl')) {
    throw new Error(`Invalid stability run state: ${runStatePath}`);
  }
  stabilitySessionPath = state.sessionPath;
  return stabilitySessionPath;
}

async function selectSessionByPath(page: Page, expectedPath: string): Promise<string> {
  const tabs = page.locator('.session-tab[data-tab-path]');
  await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  let stabilityTab: Locator | null = null;
  for (let index = 0; index < await tabs.count(); index += 1) {
    const candidate = tabs.nth(index);
    if (await candidate.getAttribute('data-tab-path') === expectedPath) {
      stabilityTab = candidate;
      break;
    }
  }
  expect(stabilityTab, `tab for ${expectedPath}`).not.toBeNull();
  if (!stabilityTab) throw new Error(`Stability session tab is not open: ${expectedPath}`);
  await stabilityTab.getByRole('tab').click();
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeEditable();
  return activeSessionPath(page);
}

async function selectStabilitySession(page: Page): Promise<string> {
  return selectSessionByPath(page, await loadStabilitySessionPath());
}

async function waitForCompletedReply(page: Page, marker: string): Promise<Locator> {
  const reply = page.locator('[data-role="assistant"]').filter({ hasText: marker }).last();
  await expect(reply).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole('button', { name: 'Interrupt response' })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeEditable();
  return reply;
}

test.describe('pie browser UI capped live race tests', () => {
  test.skip(!liveModelRun, 'Run npm run test:browser:live-model; this suite sends real model requests.');

  test('creates an isolated session and completes one Ollama DeepSeek turn', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeEditable();
    await assertProviderGate(page);

    const prompt = '[pie-stability-2026-08-24] Read-only UI test. Do not use tools or change anything. Compute 17*19 internally and reply with exactly: ROOT_OK_323';
    const existingTab = page.locator('.session-tab[data-tab-path]').filter({ hasText: 'pie-stability-2026-08-24' }).last();
    if (await existingTab.count() > 0) await existingTab.getByRole('tab').click();
    const existingPrompt = page.locator('[data-role="user"]').filter({ hasText: prompt });
    if (await existingPrompt.count() === 0) {
      const previousPath = await activeSessionPath(page);
      await page.getByRole('button', { name: 'New session' }).click();
      await expect.poll(() => activeSessionPath(page), { timeout: 30_000 }).not.toBe(previousPath);
      await expect.poll(() => activeSessionPath(page), { timeout: 30_000 }).not.toContain('pending:');
      await expect(page.locator('[data-role="user"]')).toHaveCount(0);
      await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
      await page.getByRole('textbox', { name: 'Message composer' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message' }).click();
    }
    const sessionPath = await activeSessionPath(page);
    await recordStabilitySessionPath(sessionPath);
    expect(sessionPath).toMatch(/\.jsonl$/u);
    await expect(page.locator('[data-role="user"]').filter({ hasText: prompt })).toHaveCount(1);
    await waitForCompletedReply(page, 'ROOT_OK_323');

    const provenance = await assertSessionProvenance(sessionPath);

    const cost = page.locator('[aria-label^="Estimated session cost"], [aria-label^="Known estimated session cost"]');
    await expect(cost).toBeVisible();
    console.log(JSON.stringify({ event: 'pie-live-baseline', sessionPath, provenance, cost: await cost.textContent(), costDetail: await cost.getAttribute('title') }));
  });

  test('delivers one queued follow-up exactly once and in order', async ({ page }) => {
    test.setTimeout(360_000);
    await page.goto('/');
    await assertProviderGate(page);
    const sessionPath = await selectStabilitySession(page);
    const promptA = '[pie-stability:queue-a] Read-only UI test. Do not use tools or change anything. Compute 29*31 and reply with exactly: QUEUE_A_899';
    const promptB = '[pie-stability:queue-b] Read-only UI test. Do not use tools or change anything. Compute 7*13 and reply with exactly: QUEUE_B_91';
    const userA = page.locator('[data-role="user"]').filter({ hasText: promptA });
    const userB = page.locator('[data-role="user"]').filter({ hasText: promptB });

    if (await userA.count() === 0) {
      await page.getByRole('textbox', { name: 'Message composer' }).fill(promptA);
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect(page.getByRole('button', { name: 'Interrupt response' })).toBeVisible({ timeout: 30_000 });
      await page.getByRole('textbox', { name: 'Message composer' }).fill(promptB);
      await page.getByRole('button', { name: 'Queue message' }).click();
      await expect(userB).toHaveAttribute('data-queued', 'true');
    }

    await expect(userA).toHaveCount(1);
    await expect(userB).toHaveCount(1);
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: 'QUEUE_A_899' })).toHaveCount(1, { timeout: 180_000 });
    await waitForCompletedReply(page, 'QUEUE_B_91');
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: 'QUEUE_A_899' })).toHaveCount(1);
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: 'QUEUE_B_91' })).toHaveCount(1);
    await expect(userB).not.toHaveAttribute('data-queued', 'true');

    const userIds = await page.locator('[data-role="user"]').evaluateAll((messages) => messages.map((message) => message.getAttribute('data-message-id')));
    const indexA = userIds.indexOf(await userA.getAttribute('data-message-id'));
    const indexB = userIds.indexOf(await userB.getAttribute('data-message-id'));
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThan(indexA);
    const provenance = await assertSessionProvenance(sessionPath);
    const cost = page.locator('[aria-label^="Estimated session cost"], [aria-label^="Known estimated session cost"]');
    console.log(JSON.stringify({ event: 'pie-live-queue', sessionPath, provenance, cost: await cost.textContent() }));
  });

  test('interrupts immediately without duplicate completion and recovers input', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await assertProviderGate(page);
    const sessionPath = await selectStabilitySession(page);
    const prompt = '[pie-stability:interrupt-early] Read-only UI test. Do not use tools or change anything. Think about the sum from 1 to 100000, then reply exactly: EARLY_SHOULD_NOT_COMPLETE';
    const user = page.locator('[data-role="user"]').filter({ hasText: prompt });

    if (await user.count() === 0) {
      await page.getByRole('textbox', { name: 'Message composer' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message' }).click();
      const interrupt = page.getByRole('button', { name: 'Interrupt response' });
      await expect(interrupt).toBeVisible({ timeout: 30_000 });
      await interrupt.click();
    }

    await expect(user).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Stopping response|Interrupt response/u })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('[data-role="assistant"][data-streaming="true"]')).toHaveCount(0);
    const finalWasObserved = await page.locator('[data-role="assistant"]').getByText('EARLY_SHOULD_NOT_COMPLETE', { exact: true }).count() > 0;
    const composer = page.getByRole('textbox', { name: 'Message composer' });
    await expect(composer).toBeEditable();
    await composer.fill('RECOVERY_DRAFT_NOT_SENT');
    await expect(composer).toHaveValue('RECOVERY_DRAFT_NOT_SENT');
    await composer.fill('');

    const provenance = await assertSessionProvenance(sessionPath);
    console.log(JSON.stringify({ event: 'pie-live-interrupt-early', sessionPath, provenance, outcome: finalWasObserved ? 'completion-won-race' : 'interrupted' }));
  });

  test('does not admit late final output after two long early interrupts', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    await assertProviderGate(page);
    const sessionPath = await selectStabilitySession(page);
    const cases = [
      { id: 'interrupt-long-1', final: 'LONG_INTERRUPT_1_SHOULD_NOT_COMPLETE' },
      { id: 'interrupt-long-2', final: 'LONG_INTERRUPT_2_SHOULD_NOT_COMPLETE' },
    ];
    const outcomes: Array<{ id: string; finalObserved: boolean }> = [];

    for (const scenario of cases) {
      const prompt = `[pie-stability:${scenario.id}] Read-only UI test. Do not use tools or change anything. Before the final answer, visibly enumerate and verify the squares of every integer from 1 through 80. Then reply exactly: ${scenario.final}`;
      const user = page.locator('[data-role="user"]').filter({ hasText: prompt });
      if (await user.count() === 0) {
        await page.getByRole('textbox', { name: 'Message composer' }).fill(prompt);
        await page.getByRole('button', { name: 'Send message' }).click();
        const interrupt = page.getByRole('button', { name: 'Interrupt response' });
        await expect(interrupt).toBeVisible({ timeout: 30_000 });
        await interrupt.click();
      }
      await expect(user).toHaveCount(1);
      await expect(page.getByRole('button', { name: /Stopping response|Interrupt response/u })).toHaveCount(0, { timeout: 30_000 });
      await page.waitForTimeout(5_000);
      await page.reload();
      await selectStabilitySession(page);
      const finalObserved = await page.locator('[data-role="assistant"]').getByText(scenario.final, { exact: true }).count() > 0;
      outcomes.push({ id: scenario.id, finalObserved });
    }

    const provenance = await assertSessionProvenance(sessionPath);
    console.log(JSON.stringify({ event: 'pie-live-interrupt-long', sessionPath, provenance, outcomes }));
    expect(outcomes).toEqual([
      { id: 'interrupt-long-1', finalObserved: false },
      { id: 'interrupt-long-2', finalObserved: false },
    ]);
  });

  test('reconnects one renderer and interrupts mid-stream from a second renderer', async ({ context, page }) => {
    test.setTimeout(240_000);
    await captureBrowserSockets(page);
    await page.goto('/');
    await assertProviderGate(page);
    const sessionPath = await selectStabilitySession(page);
    const prompt = '[pie-stability:interrupt-mid] Read-only UI test. Do not use tools or change anything. Solve 1234567*7654321 by long multiplication and double-check each partial product, then reply exactly: MID_SHOULD_NOT_COMPLETE';
    const user = page.locator('[data-role="user"]').filter({ hasText: prompt });

    if (await user.count() === 0) {
      await page.getByRole('textbox', { name: 'Message composer' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message' }).click();
    }
    await expect(user).toHaveCount(1);
    const streaming = page.locator('[data-role="assistant"][data-streaming="true"]').last();
    await expect(streaming).toBeVisible({ timeout: 60_000 });

    const second = await context.newPage();
    await second.goto('/');
    await selectStabilitySession(second);
    await expect(second.locator('[data-role="user"]').filter({ hasText: prompt })).toHaveCount(1);
    await expect(second.getByRole('button', { name: 'Interrupt response' })).toBeVisible();
    await second.bringToFront();

    const socketCount = await page.evaluate(() => (window as BrowserSocketWindow).__pieTestSockets?.length ?? 0);
    await page.evaluate(() => {
      const sockets = (window as BrowserSocketWindow).__pieTestSockets ?? [];
      sockets.at(-1)?.close(1000, 'playwright mid-stream reconnect');
    });
    await expect.poll(
      () => page.evaluate(() => (window as BrowserSocketWindow).__pieTestSockets?.length ?? 0),
      { timeout: 30_000 },
    ).toBeGreaterThan(socketCount);
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeEditable();
    await expect(user).toHaveCount(1);

    await second.getByRole('button', { name: 'Interrupt response' }).click();
    await expect(second.getByRole('button', { name: /Stopping response|Interrupt response/u })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Stopping response|Interrupt response/u })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('[data-role="assistant"][data-streaming="true"]')).toHaveCount(0);
    await expect(second.locator('[data-role="assistant"][data-streaming="true"]')).toHaveCount(0);
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: 'MID_SHOULD_NOT_COMPLETE' })).toHaveCount(0);
    await expect(second.locator('[data-role="user"]').filter({ hasText: prompt })).toHaveCount(1);

    const provenance = await assertSessionProvenance(sessionPath);
    console.log(JSON.stringify({ event: 'pie-live-interrupt-mid-reconnect', sessionPath, provenance, socketCountBefore: socketCount }));
  });

  test('answers ask_user and settles exactly two sibling DeepSeek children', async ({ page }) => {
    test.setTimeout(480_000);
    await page.goto('/');
    await assertProviderGate(page);

    let sessionPath: string | undefined;
    try {
      const saved = JSON.parse(await readFile(finalSessionStatePath, 'utf8')) as { sessionPath?: unknown };
      if (typeof saved.sessionPath === 'string') sessionPath = saved.sessionPath;
    } catch {
      // First and only paid attempt creates the isolated final session below.
    }
    const marker = '[pie-stability:ask-sibling-children]';
    const user = page.locator('[data-role="user"]').filter({ hasText: marker });
    if (sessionPath?.startsWith('__pending__')) {
      await expect(user).toHaveCount(1);
      await expect.poll(() => activeSessionPath(page), { timeout: 30_000 }).not.toContain('__pending__');
      sessionPath = await activeSessionPath(page);
      await writeFile(finalSessionStatePath, `${JSON.stringify({ sessionPath }, null, 2)}\n`, 'utf8');
    } else if (sessionPath) {
      await selectSessionByPath(page, sessionPath);
    } else {
      const previousPath = await activeSessionPath(page);
      await page.getByRole('button', { name: 'New session' }).click();
      await expect.poll(() => activeSessionPath(page), { timeout: 30_000 }).not.toBe(previousPath);
      await expect.poll(() => activeSessionPath(page), { timeout: 30_000 }).not.toContain('__pending__');
      sessionPath = await activeSessionPath(page);
      await mkdir(path.dirname(finalSessionStatePath), { recursive: true });
      await writeFile(finalSessionStatePath, `${JSON.stringify({ sessionPath }, null, 2)}\n`, 'utf8');
    }

    const prompt = [
      '[pie-stability:ask-sibling-children] Read-only UI test; do not change files or access the network.',
      'First call ask_user exactly once with question "Choose safe test path", options ["Continue"], and allowCustom false.',
      'After the answer, issue exactly two subagent calls as siblings in one assistant response, both with bucket small:',
      '(1) scout task: "Do not use tools or inspect files. Compute 11*13 internally and include CHILD_A_143 in the shortest possible reply."',
      '(2) reviewer task: "Do not use tools or inspect files. Compute 17+19 internally and include CHILD_B_36 in the shortest possible reply."',
      'Do not launch nested children. After both settle, reply exactly: FINAL_CHILDREN_OK',
    ].join(' ');
    if (await user.count() === 0) {
      await page.getByRole('textbox', { name: 'Message composer' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message' }).click();
    }
    await expect(user).toHaveCount(1);

    const continueOption = page.getByRole('option', { name: 'Continue', exact: true });
    if (await page.getByText('FINAL_CHILDREN_OK', { exact: true }).count() === 0) {
      await expect(continueOption).toBeVisible({ timeout: 120_000 });
      await continueOption.click();
      await expect(continueOption).toHaveCount(0, { timeout: 30_000 });
    }

    await waitForCompletedReply(page, 'FINAL_CHILDREN_OK');
    const childCards = page.getByRole('button', { name: /Toggle (scout|reviewer) subagent/iu });
    await expect(childCards).toHaveCount(2);
    await expect(page.locator('.tool-call-subagent.running, .tool-call-subagent.idle')).toHaveCount(0);

    await expect.poll(async () => (await sessionChildProvenance(sessionPath!)).length, { timeout: 30_000 }).toBe(2);
    const children = await sessionChildProvenance(sessionPath);
    expect(children.map((child) => child.agent).sort()).toEqual(['reviewer', 'scout']);
    for (const child of children) {
      expect(child.provider).toBe('ollama');
      expect(child.model).toBe('deepseek-v4-flash:0731-cloud');
      expect(child.thinkingLevel).toBe('max');
      expect(child.exitCode).toBe(0);
    }
    expect(children.some((child) => child.task.includes('CHILD_A_143'))).toBe(true);
    expect(children.some((child) => child.task.includes('CHILD_B_36'))).toBe(true);

    const provenance = await assertSessionProvenance(sessionPath);
    console.log(JSON.stringify({ event: 'pie-live-ask-sibling-children', sessionPath, provenance, children }));
  });
});
