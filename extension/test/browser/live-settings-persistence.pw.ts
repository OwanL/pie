// Playwright-only live spec; the .pw.ts suffix keeps it out of node:test.
// This mutates one idle session's model/reasoning choices, restarts the real
// backend without sending a prompt, verifies fresh hydration, then restores
// the original choices in a finally block.
import { expect, test, type Locator, type Page } from '@playwright/test';

const runLiveSettings = process.env.PIE_BROWSER_LIVE_SETTINGS === '1';

interface RecordedFrame {
  type?: string;
  clientCommandId?: string;
  decision?: string;
  viewGeneration?: number;
  backendReady?: boolean;
  activeSessionPath?: string;
  busy?: boolean;
  activeModelId?: string;
  activeProvider?: string;
  activeThinkingLevel?: string;
  defaultModelId?: string;
  defaultProvider?: string;
  defaultThinkingLevel?: string;
}

interface TrackedBrowserWindow extends Window {
  __pieTestSockets?: WebSocket[];
  __pieIncomingFrames?: RecordedFrame[];
  __pieOutgoingFrames?: RecordedFrame[];
  __pieNoSpendCommandCounts?: Record<string, number>;
}

async function installSocketRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as TrackedBrowserWindow;
    const NativeWebSocket = window.WebSocket;
    tracked.__pieTestSockets = [];
    tracked.__pieIncomingFrames = [];
    tracked.__pieOutgoingFrames = [];
    try {
      const persisted = JSON.parse(sessionStorage.getItem('__pieLiveSettingsNoSpend') ?? '{}');
      tracked.__pieNoSpendCommandCounts = persisted && typeof persisted === 'object' ? persisted : {};
    } catch {
      tracked.__pieNoSpendCommandCounts = {};
    }

    const summarize = (value: unknown): RecordedFrame | null => {
      if (!value || typeof value !== 'object') return null;
      const frame = value as Record<string, unknown>;
      if (frame.type === 'state') {
        const state = frame.state && typeof frame.state === 'object'
          ? frame.state as Record<string, unknown>
          : undefined;
        const activeSession = state?.activeSession && typeof state.activeSession === 'object'
          ? state.activeSession as Record<string, unknown>
          : undefined;
        const modelSettings = state?.modelSettings && typeof state.modelSettings === 'object'
          ? state.modelSettings as Record<string, unknown>
          : undefined;
        return {
          type: 'state',
          backendReady: state?.backendReady === true,
          ...(typeof activeSession?.path === 'string' ? { activeSessionPath: activeSession.path } : {}),
          ...(typeof state?.busy === 'boolean' ? { busy: state.busy } : {}),
          ...(typeof activeSession?.modelId === 'string' ? { activeModelId: activeSession.modelId } : {}),
          ...(typeof activeSession?.provider === 'string' ? { activeProvider: activeSession.provider } : {}),
          ...(typeof activeSession?.thinkingLevel === 'string' ? { activeThinkingLevel: activeSession.thinkingLevel } : {}),
          ...(typeof modelSettings?.defaultModel === 'string' ? { defaultModelId: modelSettings.defaultModel } : {}),
          ...(typeof modelSettings?.defaultProvider === 'string' ? { defaultProvider: modelSettings.defaultProvider } : {}),
          ...(typeof modelSettings?.defaultThinkingLevel === 'string' ? { defaultThinkingLevel: modelSettings.defaultThinkingLevel } : {}),
        };
      }
      return {
        ...(typeof frame.type === 'string' ? { type: frame.type } : {}),
        ...(typeof frame.clientCommandId === 'string' ? { clientCommandId: frame.clientCommandId } : {}),
        ...(typeof frame.decision === 'string' ? { decision: frame.decision } : {}),
        ...(typeof frame.viewGeneration === 'number' ? { viewGeneration: frame.viewGeneration } : {}),
      };
    };

    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        tracked.__pieTestSockets?.push(this);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const frame = summarize(JSON.parse(event.data));
            if (frame) tracked.__pieIncomingFrames?.push(frame);
          } catch {
            // Production transport owns malformed-frame handling.
          }
        });
      }

      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === 'string') {
          try {
            const frame = summarize(JSON.parse(data));
            if (frame) {
              tracked.__pieOutgoingFrames?.push(frame);
              if (['send', 'compact', 'retrySend', 'startNewTask', 'continueTask'].includes(frame.type ?? '')) {
                const counts = tracked.__pieNoSpendCommandCounts ?? {};
                counts[frame.type!] = (counts[frame.type!] ?? 0) + 1;
                tracked.__pieNoSpendCommandCounts = counts;
                try { sessionStorage.setItem('__pieLiveSettingsNoSpend', JSON.stringify(counts)); } catch { /* instrumentation only */ }
              }
            }
          } catch {
            // Production transport owns serialization errors.
          }
        }
        super.send(data);
      }
    }

    window.WebSocket = TrackedWebSocket;
  });
}

async function expectReady(page: Page): Promise<void> {
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeEditable({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator('[data-connection-banner]')).toHaveCount(0);
  // ViewState.busy is host-authoritative. Waiting for the explicit false
  // value catches a stale/replayed snapshot without relying on a transient
  // Stop/Interrupt button in the webview.
  await expect.poll(async () => await page.evaluate(() => {
    const frames = (window as TrackedBrowserWindow).__pieIncomingFrames ?? [];
    return [...frames].reverse().find((frame) => frame.type === 'state' && frame.backendReady === true)?.busy ?? null;
  }), { timeout: 30_000 }).toBe(false);
}

async function frameCount(page: Page, direction: 'incoming' | 'outgoing', type: string): Promise<number> {
  return await page.evaluate(({ direction: side, type: wanted }) => {
    const tracked = window as TrackedBrowserWindow;
    const frames = side === 'incoming' ? tracked.__pieIncomingFrames : tracked.__pieOutgoingFrames;
    return (frames ?? []).filter((frame) => frame.type === wanted).length;
  }, { direction, type });
}

const NO_SPEND_COMMAND_TYPES = ['send', 'compact', 'retrySend', 'startNewTask', 'continueTask'] as const;

async function noSpendCommandCounts(page: Page): Promise<Record<string, number>> {
  return await page.evaluate((types) => {
    const frames = (window as TrackedBrowserWindow).__pieOutgoingFrames ?? [];
    const tracked = (window as TrackedBrowserWindow).__pieNoSpendCommandCounts ?? {};
    return Object.fromEntries(types.map((type) => [type, tracked[type] ?? frames.filter((frame) => frame.type === type).length]));
  }, NO_SPEND_COMMAND_TYPES);
}

async function authoritativeConfiguration(page: Page): Promise<RecordedFrame | null> {
  return await page.evaluate(() => {
    const frames = (window as TrackedBrowserWindow).__pieIncomingFrames ?? [];
    return [...frames].reverse().find((frame) => frame.type === 'state' && frame.backendReady === true) ?? null;
  });
}

async function waitForAuthoritativeConfiguration(
  page: Page,
  expected: Pick<RecordedFrame, 'activeModelId' | 'activeProvider' | 'activeThinkingLevel' | 'defaultModelId' | 'defaultProvider' | 'defaultThinkingLevel'>,
): Promise<void> {
  await expect.poll(async () => {
    const state = await authoritativeConfiguration(page);
    return state ? {
      activeModelId: state.activeModelId,
      activeProvider: state.activeProvider,
      activeThinkingLevel: state.activeThinkingLevel,
      defaultModelId: state.defaultModelId,
      defaultProvider: state.defaultProvider,
      defaultThinkingLevel: state.defaultThinkingLevel,
    } : null;
  }, { timeout: 30_000 }).toEqual(expected);
}

async function waitForAcceptedCommandAfter(
  page: Page,
  type: string,
  previousCount: number,
): Promise<string> {
  await expect.poll(
    async () => await frameCount(page, 'outgoing', type),
    { timeout: 30_000 },
  ).toBeGreaterThan(previousCount);
  const clientCommandId = await page.evaluate(({ type: wanted, previousCount: before }) => {
    const frames = (window as TrackedBrowserWindow).__pieOutgoingFrames ?? [];
    return frames.filter((frame) => frame.type === wanted).slice(before).at(-1)?.clientCommandId ?? null;
  }, { type, previousCount });
  expect(clientCommandId).toBeTruthy();
  await expect.poll(async () => await page.evaluate((id) => {
    const frames = (window as TrackedBrowserWindow).__pieIncomingFrames ?? [];
    return frames.find((frame) => frame.type === 'commandAck' && frame.clientCommandId === id)?.decision ?? null;
  }, clientCommandId), { timeout: 30_000 }).toBe('accepted');
  return clientCommandId!;
}

async function optionByStableId(page: Page, id: string): Promise<Locator> {
  // Preact's useId prefix is render-instance owned; provider/model identity is
  // the stable suffix and survives a full page hydration.
  const optionMarker = id.indexOf('-option-');
  const stableSuffix = optionMarker >= 0 ? id.slice(optionMarker) : id;
  const options = page.getByRole('option');
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index);
    const candidateId = await option.getAttribute('id');
    if (candidateId === id || candidateId?.endsWith(stableSuffix)) return option;
  }
  throw new Error(`Picker option disappeared: ${id}`);
}

async function authoritativeActiveSessionPath(page: Page): Promise<string> {
  await expect.poll(async () => (await authoritativeConfiguration(page))?.activeSessionPath ?? null, {
    timeout: 30_000,
  }).toBeTruthy();
  const value = (await authoritativeConfiguration(page))?.activeSessionPath;
  if (!value) throw new Error('The authoritative state has no active session path.');
  return value;
}

async function tabByPath(page: Page, sessionPath: string): Promise<Locator | null> {
  const tabs = page.locator('.session-tab[data-tab-path]');
  for (let index = 0; index < await tabs.count(); index += 1) {
    const tab = tabs.nth(index);
    if (await tab.getAttribute('data-tab-path') === sessionPath) return tab.getByRole('tab');
  }
  return null;
}

async function exerciseCompactSettingsPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('tab', { name: 'History' }).click();
  const summaryModel = settings.getByRole('button', { name: 'Summary model' });
  await expect(summaryModel).toBeVisible();
  if (await summaryModel.isEnabled()) {
    const originalLabel = (await summaryModel.innerText()).trim();
    await summaryModel.click();
    const listbox = page.getByRole('listbox', { name: 'Summary model' });
    await expect(listbox).toBeVisible();
    const selected = listbox.getByRole('option', { selected: true });
    if (await selected.count() > 0) {
      // Re-selecting the current compact-row value is no-spend and leaves the
      // preference unchanged, while still proving that a portaled option click
      // commits without dismissing the owning Settings dialog.
      await selected.click();
      await expect(settings).toBeVisible();
      await expect(summaryModel).toHaveText(originalLabel);
    } else {
      await page.getByRole('combobox', { name: 'Summary model' }).press('Escape');
      await expect(settings).toBeVisible();
    }
  }
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(settings).toHaveCount(0);
}

async function restartBackendAndWait(page: Page): Promise<void> {
  const incomingBeforeRestart = await page.evaluate(() => (
    (window as TrackedBrowserWindow).__pieIncomingFrames ?? []
  ).length);
  const restartCommandId = await page.evaluate(() => {
    const tracked = window as TrackedBrowserWindow;
    const socket = tracked.__pieTestSockets?.at(-1);
    const hello = [...(tracked.__pieIncomingFrames ?? [])]
      .reverse()
      .find((frame) => frame.type === 'rendererHello');
    if (!socket || socket.readyState !== WebSocket.OPEN || hello?.viewGeneration === undefined) {
      throw new Error('No ready browser socket/rendererHello is available for restart.');
    }
    const clientCommandId = crypto.randomUUID();
    socket.send(JSON.stringify({
      type: 'restartBackend',
      viewGeneration: hello.viewGeneration,
      clientCommandId,
    }));
    return clientCommandId;
  });
  await expect.poll(async () => await page.evaluate((id) => {
    const frames = (window as TrackedBrowserWindow).__pieIncomingFrames ?? [];
    return frames.find((frame) => frame.type === 'commandAck' && frame.clientCommandId === id)?.decision ?? null;
  }, restartCommandId), { timeout: 30_000 }).toBe('accepted');
  await expect.poll(async () => await page.evaluate((start) => {
    const frames = ((window as TrackedBrowserWindow).__pieIncomingFrames ?? []).slice(start);
    return frames.some((frame) => frame.type === 'state' && frame.backendReady === false);
  }, incomingBeforeRestart), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => await page.evaluate((start) => {
    const frames = ((window as TrackedBrowserWindow).__pieIncomingFrames ?? []).slice(start);
    const notReady = frames.findIndex((frame) => frame.type === 'state' && frame.backendReady === false);
    return notReady >= 0 && frames.slice(notReady + 1)
      .some((frame) => frame.type === 'state' && frame.backendReady === true);
  }, incomingBeforeRestart), { timeout: 120_000 }).toBe(true);
  await expectReady(page);
}

test.describe('pie no-spend live settings durability', () => {
  test.skip(!runLiveSettings, 'Set PIE_BROWSER_LIVE_SETTINGS=1; this changes and restores live settings without sending a prompt.');

  test('model and reasoning survive tab switches, a real backend restart, and fresh hydration', async ({ page }) => {
    test.setTimeout(360_000);
    const unexpectedErrors: string[] = [];
    page.on('pageerror', (error) => unexpectedErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') unexpectedErrors.push(`console: ${message.text()}`);
    });
    await installSocketRecorder(page);
    await page.goto('/');
    await expectReady(page);
    // Establish a fresh backend generation before the first mutation. The
    // active transcript is then hydrated through the runtime-free cold path,
    // so this run does not accidentally validate only a pre-existing hot SDK
    // manager.
    await restartBackendAndWait(page);
    await page.reload();
    await expectReady(page);

    const sessionPath = await authoritativeActiveSessionPath(page);
    const initialConfiguration = await authoritativeConfiguration(page);
    if (!initialConfiguration
      || initialConfiguration.activeModelId !== initialConfiguration.defaultModelId
      || initialConfiguration.activeProvider !== initialConfiguration.defaultProvider
      || initialConfiguration.activeThinkingLevel !== initialConfiguration.defaultThinkingLevel
      || initialConfiguration.activeSessionPath !== sessionPath) {
      throw new Error(
        'The active session must initially match the global model defaults so this live check can restore both exactly.',
      );
    }
    const noSpendBaseline = await noSpendCommandCounts(page);
    await exerciseCompactSettingsPicker(page);
    expect(await noSpendCommandCounts(page)).toEqual(noSpendBaseline);
    const modelButton = page.getByRole('button', { name: 'Model' });
    const reasoningButton = page.getByRole('button', { name: 'Reasoning level' });
    const originalModelLabel = (await modelButton.innerText()).trim();
    const originalReasoningLabel = (await reasoningButton.innerText()).trim();
    let originalModelOptionId: string | null = null;
    let changedModelLabel: string | null = null;
    let changedReasoningLabel: string | null = null;

    try {
      await modelButton.click();
      const selectedModel = page.getByRole('option', { selected: true });
      originalModelOptionId = await selectedModel.getAttribute('id');
      if (!originalModelOptionId) throw new Error('The selected model option has no stable identity.');
      const modelOptions = page.getByRole('option');
      const candidates: Array<{ index: number; text: string }> = [];
      for (let index = 0; index < await modelOptions.count(); index += 1) {
        const option = modelOptions.nth(index);
        if (await option.getAttribute('id') === originalModelOptionId || await option.isDisabled()) continue;
        candidates.push({ index, text: (await option.innerText()).trim() });
      }
      const alternateModel = candidates.find((candidate) => /Luna|Sol/iu.test(candidate.text)) ?? candidates[0];
      if (!alternateModel) throw new Error('At least two configured models are required for the live persistence check.');
      const modelCommandCount = await frameCount(page, 'outgoing', 'setModel');
      await modelOptions.nth(alternateModel.index).click();
      // UX contract: the picker is optimistic. A cold SDK open/commit may take
      // longer, but the visible choice must never wait for that I/O.
      await expect(modelButton).not.toHaveText(originalModelLabel, { timeout: 1_000 });
      await waitForAcceptedCommandAfter(page, 'setModel', modelCommandCount);
      await expect.poll(async () => {
        const state = await authoritativeConfiguration(page);
        return state?.activeModelId !== initialConfiguration.activeModelId;
      }, { timeout: 30_000 }).toBe(true);
      changedModelLabel = (await modelButton.innerText()).trim();

      const reasoningBeforeExplicitChange = (await reasoningButton.innerText()).trim();
      const reasoningBeforeExplicitConfiguration = await authoritativeConfiguration(page);
      if (!reasoningBeforeExplicitConfiguration) throw new Error('No authoritative state after model change.');
      await reasoningButton.click();
      const reasoningOptions = page.getByRole('option');
      const selectedReasoning = page.getByRole('option', { selected: true });
      const selectedReasoningText = (await selectedReasoning.innerText()).trim();
      let alternateReasoning: Locator | null = null;
      for (let index = 0; index < await reasoningOptions.count(); index += 1) {
        const option = reasoningOptions.nth(index);
        if ((await option.innerText()).trim() !== selectedReasoningText && !await option.isDisabled()) {
          alternateReasoning = option;
          break;
        }
      }
      if (!alternateReasoning) throw new Error('The selected model exposes no alternate reasoning level.');
      const reasoningCommandCount = await frameCount(page, 'outgoing', 'setModel');
      await alternateReasoning.click();
      await expect(reasoningButton).not.toHaveText(reasoningBeforeExplicitChange, { timeout: 1_000 });
      await waitForAcceptedCommandAfter(page, 'setModel', reasoningCommandCount);
      await expect.poll(async () => {
        const state = await authoritativeConfiguration(page);
        return state?.activeThinkingLevel !== reasoningBeforeExplicitConfiguration.activeThinkingLevel;
      }, { timeout: 30_000 }).toBe(true);
      changedReasoningLabel = (await reasoningButton.innerText()).trim();

      await restartBackendAndWait(page);

      await page.reload();
      await expectReady(page);
      await expect(page.getByRole('button', { name: 'Model' })).toHaveText(changedModelLabel);
      await expect(page.getByRole('button', { name: 'Reasoning level' })).toHaveText(changedReasoningLabel);

      const otherTab = page.locator('.session-tab[data-tab-path]').filter({
        has: page.getByRole('tab', { selected: false }),
      }).first();
      const restoredTab = await tabByPath(page, sessionPath);
      if (restoredTab && await otherTab.count() > 0) {
        await otherTab.getByRole('tab').click();
        await expect(otherTab.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
        await restoredTab.click();
        await expect(restoredTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('button', { name: 'Model' })).toHaveText(changedModelLabel);
        await expect(page.getByRole('button', { name: 'Reasoning level' })).toHaveText(changedReasoningLabel);
      }
    } finally {
      // Restore the user's original per-session choices even if an assertion
      // after the restart fails. A fresh page ensures we operate on the latest
      // authoritative backend generation rather than a stale picker portal.
      if (!page.isClosed() && originalModelOptionId) {
        await page.reload().catch(() => undefined);
        await expectReady(page).catch(() => undefined);
        const currentModel = page.getByRole('button', { name: 'Model' });
        if (await currentModel.isVisible().catch(() => false)
          && (await currentModel.innerText()).trim() !== originalModelLabel) {
          await currentModel.click();
          const originalModel = await optionByStableId(page, originalModelOptionId);
          const restoreModelCount = await frameCount(page, 'outgoing', 'setModel');
          await originalModel.click();
          await waitForAcceptedCommandAfter(page, 'setModel', restoreModelCount);
        }
        const currentReasoning = page.getByRole('button', { name: 'Reasoning level' });
        if (await currentReasoning.isVisible().catch(() => false)
          && (await currentReasoning.innerText()).trim() !== originalReasoningLabel) {
          await currentReasoning.click();
          const originalReasoning = page.getByRole('option', { name: originalReasoningLabel, exact: true });
          const restoreReasoningCount = await frameCount(page, 'outgoing', 'setModel');
          await originalReasoning.click();
          await waitForAcceptedCommandAfter(page, 'setModel', restoreReasoningCount);
        }
        // The command acknowledgement only means the host accepted the
        // request. Wait for the restored values to be projected authoritatively
        // before asking the backend to restart; that restart is the durability
        // barrier which drains any in-flight cold-session write.
        await waitForAuthoritativeConfiguration(page, {
          activeModelId: initialConfiguration.activeModelId,
          activeProvider: initialConfiguration.activeProvider,
          activeThinkingLevel: initialConfiguration.activeThinkingLevel,
          defaultModelId: initialConfiguration.defaultModelId,
          defaultProvider: initialConfiguration.defaultProvider,
          defaultThinkingLevel: initialConfiguration.defaultThinkingLevel,
        });
        await restartBackendAndWait(page);
        await page.reload();
        await expectReady(page);
        await expect(page.getByRole('button', { name: 'Model' })).toHaveText(originalModelLabel);
        await expect(page.getByRole('button', { name: 'Reasoning level' })).toHaveText(originalReasoningLabel);
        await waitForAuthoritativeConfiguration(page, {
          activeModelId: initialConfiguration.activeModelId,
          activeProvider: initialConfiguration.activeProvider,
          activeThinkingLevel: initialConfiguration.activeThinkingLevel,
          defaultModelId: initialConfiguration.defaultModelId,
          defaultProvider: initialConfiguration.defaultProvider,
          defaultThinkingLevel: initialConfiguration.defaultThinkingLevel,
        });
        expect(await noSpendCommandCounts(page)).toEqual(noSpendBaseline);
      }
    }

    expect(unexpectedErrors).toEqual([]);
  });
});
