// Playwright-only spec; the .pw.ts suffix keeps it out of pie's node:test discovery.
import type { Page } from '@playwright/test';

import { EMPTY_AGGREGATE_STATS } from '../../../application/lib/protocol/index.js';
import { expect, test } from './ui-smoke-fixtures.js';

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

async function openComposer(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('.composer-bottom-bar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'More composer options', exact: true })).toBeVisible();
  await expect(page.locator('.composer-pinned-controls [aria-label="Settings"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Model' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reasoning level' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function getToolbarHitboxOverlaps(page: Page): Promise<Array<{ a: string; b: string; overlapX: number; overlapY: number }>> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      '.composer-bottom-bar button, .composer-bottom-bar [role="button"]',
    )).filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    });
    const hitboxes = controls.map((element) => {
      const rect = element.getBoundingClientRect();
      const pseudo = getComputedStyle(element, '::before');
      const inset = (side: 'top' | 'right' | 'bottom' | 'left') => {
        const value = Number.parseFloat(pseudo[side]);
        return Number.isFinite(value) ? value : 0;
      };
      return {
        name: element.getAttribute('aria-label') || element.textContent?.trim() || element.className.toString(),
        left: rect.left + inset('left'),
        right: rect.right - inset('right'),
        top: rect.top + inset('top'),
        bottom: rect.bottom - inset('bottom'),
      };
    });
    const overlaps: Array<{ a: string; b: string; overlapX: number; overlapY: number }> = [];
    for (let first = 0; first < hitboxes.length; first += 1) {
      for (let second = first + 1; second < hitboxes.length; second += 1) {
        const a = hitboxes[first]!;
        const b = hitboxes[second]!;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 0.25 && overlapY > 0.25) {
          overlaps.push({ a: a.name, b: b.name, overlapX, overlapY });
        }
      }
    }
    return overlaps;
  });
}

test.describe('composer toolbar overflow in Chromium', () => {
  test.use({
    viewState: {
      modelSettings: { defaultModel: 'fixture-model', defaultProvider: 'fixture', defaultThinkingLevel: 'medium' },
      availableModels: [{ id: 'fixture-model', name: 'Offline fixture model', provider: 'fixture', reasoning: true, inputKinds: ['text'], contextWindow: 128_000 }],
      contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
      aggregateStats: { ...EMPTY_AGGREGATE_STATS, ready: true, todayCost: 12.84, weekCost: 68.27 },
      sessionUsage: {
        authority: 'canonical', freshness: 'fresh', refreshStatus: 'idle',
        samples: [{
          sourceId: 'toolbar-fixture', kind: 'assistant', provider: 'fixture', modelId: 'fixture-model',
          inputTokens: 42_000, outputTokens: 4_200, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 46_200, reportedCostUsd: 1.26, provenance: 'exact',
        }],
      },
      browserServer: {
        running: true, localUrl: 'http://127.0.0.1:0', port: 0, clientCount: 1,
        lanEnabled: false, configuredLanEnabled: false, lanUrls: [],
        changePending: false, pendingLanEnabled: null, changeError: null,
      },
    },
  });

  test('keeps smaller global costs adjacent to the right-hand session indicators', async ({ page }) => {
    for (const width of [800, 1000]) {
      await openComposer(page, width, 640);
      const costs = page.locator('.composer-global-indicators .aggregate-strip');
      await expect(costs).toBeVisible();
      const metrics = await costs.evaluate((element) => {
        const bar = element.closest('.composer-bottom-bar')!;
        const left = bar.querySelector('.composer-overflow-trigger:not([data-composer-overflow-measurement])')!.getBoundingClientRect();
        const right = bar.querySelector('.composer-indicators')!.getBoundingClientRect();
        const pair = element.getBoundingClientRect();
        const session = bar.querySelector('.composer-indicators .panel-chip-toolbar')!;
        // A zero-height inline-block's top is the actual inline baseline.
        // Range bottoms include font descent and hid the previous 1px error.
        const baselines = Array.from(bar.querySelectorAll<HTMLElement>(
          '.model-picker-trigger-label, .choice-picker-trigger-label, '
          + '.composer-indicators .panel-chip-label, .composer-global-indicators .aggregate-strip-cost',
        )).map((label) => {
          const text = label.firstChild!;
          const wrapper = document.createElement('span');
          const marker = document.createElement('span');
          marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;border:0;vertical-align:baseline';
          text.replaceWith(wrapper);
          wrapper.append(text, marker);
          try {
            return { text: label.textContent, baseline: marker.getBoundingClientRect().top };
          } finally {
            wrapper.replaceWith(text);
          }
        });
        return {
          leftGap: pair.left - left.right,
          rightGap: right.left - pair.right,
          fontSize: parseFloat(getComputedStyle(element).fontSize),
          sessionFontSize: parseFloat(getComputedStyle(session).fontSize),
          baselines,
        };
      });
      expect(metrics.rightGap).toBeGreaterThanOrEqual(0);
      expect(metrics.rightGap).toBeLessThanOrEqual(6);
      expect(metrics.leftGap).toBeGreaterThan(metrics.rightGap);
      expect(metrics.fontSize).toBe(8);
      expect(metrics.fontSize).toBeLessThan(metrics.sessionFontSize);
      // Model, reasoning, session cost, context, and BOTH global cost labels.
      expect(metrics.baselines).toHaveLength(6);
      const reference = metrics.baselines[0]!.baseline;
      for (const label of metrics.baselines) {
        expect(Math.abs(label.baseline - reference), `${label.text} baseline at ${width}px`).toBeLessThan(0.05);
      }
    }
  });

  test('keeps model text readable and pinned hitboxes separate at ordinary phone widths', async ({ page }) => {
    for (const width of [390, 320]) {
      await openComposer(page, width, 640);
      await expect(page.getByRole('button', { name: 'More composer options' })).toBeVisible();
      const modelLabel = page.locator('.composer-pinned-controls .model-picker-trigger-label');
      await expect(modelLabel).toBeVisible();
      const modelText = await modelLabel.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        minWidth: getComputedStyle(element).minWidth,
      }));
      expect(modelText.width, `model text width at ${width}px`).toBeGreaterThan(8);
      if (width === 320) {
        // The fixture model name is short, so temporarily stress the real
        // label with long text instead of assuming truncation must occur for
        // every selected model. The UI contract is min-width:0
        // plus ellipsis while Reasoning and More stay separate.
        const originalText = (await modelLabel.textContent()) ?? '';
        try {
          await modelLabel.evaluate((element, text) => {
            element.textContent = `${text} — ${'long model name '.repeat(8)}`;
          }, originalText);
          const constrainedLabel = await modelLabel.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              width: element.getBoundingClientRect().width,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              minWidth: style.minWidth,
              overflow: style.overflow,
              textOverflow: style.textOverflow,
              whiteSpace: style.whiteSpace,
            };
          });
          expect(constrainedLabel.scrollWidth, 'long model label content should exceed its yielded box').toBeGreaterThan(constrainedLabel.clientWidth);
          expect(constrainedLabel.minWidth).toBe('0px');
          expect(constrainedLabel.overflow).toBe('hidden');
          expect(constrainedLabel.textOverflow).toBe('ellipsis');
          expect(constrainedLabel.whiteSpace).toBe('nowrap');
          expect(await getToolbarHitboxOverlaps(page), 'long model label must not overlap pinned controls').toEqual([]);
        } finally {
          await modelLabel.evaluate((element, text) => { element.textContent = text; }, originalText);
        }
      }
      expect(await page.getByRole('button', { name: 'Model' }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(28);
      expect(await page.getByRole('button', { name: 'Reasoning level' }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(42);
      expect(await getToolbarHitboxOverlaps(page), `toolbar hitboxes at ${width}px`).toEqual([]);
    }
  });

  test('keeps mandatory controls clickable when extreme width requires compact model fallback', async ({ page }) => {
    await openComposer(page, 240, 640);
    // Once secondary items have overflowed, model text may yield fully;
    // the mandatory controls must still retain separate, usable hitboxes.
    for (const name of ['Model', 'Reasoning level', 'More composer options']) {
      const control = page.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width, `${name} clickable width`).toBeGreaterThan(0);
      expect(bounds!.height, `${name} clickable height`).toBeGreaterThan(0);
      await control.click({ trial: true });
    }
    expect(await getToolbarHitboxOverlaps(page), 'extreme compact toolbar hitboxes').toEqual([]);
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    const fixtureChoice = page.getByRole('option').filter({ hasText: 'Offline fixture model' });
    await expect(fixtureChoice).toBeVisible();
    await expect(fixtureChoice).toHaveAttribute('aria-selected', 'true');
    await fixtureChoice.click();
    await expect(fixtureChoice).toBeHidden();
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(fixtureChoice).toBeVisible();
    await expect(fixtureChoice).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps Settings permanently in More and the global pair in one measured section', async ({ page }) => {
    await openComposer(page, 1400, 700);
    const global = page.locator('.composer-global-indicators');
    await expect(global).toBeVisible();
    await expect(global.locator('.aggregate-strip-cost')).toHaveCount(2);
    await expect(page.locator('#app > .aggregate-strip')).toHaveCount(0);
    expect(await global.evaluate((element) => ({
      previous: element.previousElementSibling?.className,
      next: element.nextElementSibling?.className,
      wrap: getComputedStyle(element).flexWrap,
    }))).toEqual({ previous: 'composer-controls', next: 'composer-indicators', wrap: 'nowrap' });
    await page.getByRole('button', { name: 'More composer options' }).click();
    const more = page.getByRole('dialog', { name: 'Additional composer options' });
    await expect(more.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await more.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.toolbar-settings-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolbar-settings-menu')).toBeHidden();
    await expect(more).toBeVisible();
    await expect(more.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(more).toBeHidden();
    await page.setViewportSize({ width: 240, height: 700 });
    await expect(page.locator('.composer-global-indicators')).toHaveCount(0);
    await page.getByRole('button', { name: 'More composer options' }).click();
    await expect(more.locator('[data-toolbar-item="global-costs"] .aggregate-strip-cost')).toHaveCount(2);
    await expect(more.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  });

  test('overflow remains usable while disconnected and does not disable status indicators', async ({ context, page }) => {
    await captureBrowserSockets(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    await expect(page.locator('.composer-bottom-bar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'More composer options' })).toBeVisible();

    // Complete the close handshake before blocking reconnection: going offline
    // first can strand the socket in CLOSING without notifying the transport.
    await page.evaluate(() => {
      const sockets = (window as BrowserSocketWindow).__pieTestSockets ?? [];
      sockets.at(-1)?.close(1000, 'toolbar overflow browser regression');
    });
    await expect(page.locator('[data-connection-banner]')).toContainText('Reconnecting');
    await context.setOffline(true);

    const trigger = page.getByRole('button', { name: 'More composer options' });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const popover = page.getByRole('dialog', { name: 'Additional composer options' });
    await expect(popover).toBeVisible();
    await expect(page.getByRole('button', { name: /Enable autonomous mode|Autonomous mode on/ })).toBeDisabled();

    const indicator = popover.locator('.composer-toolbar-indicator-item [tabindex="0"]').first();
    await expect(indicator).toBeVisible();
    expect(await indicator.evaluate((element) => element.closest('fieldset:disabled'))).toBeNull();
    await indicator.focus();
    await expect(indicator).toBeFocused();
    await context.setOffline(false);
  });

  test('keeps the short-height overflow panel bounded and treats its rich tooltip as owned', async ({ page }) => {
    // Permanent secondary controls now leave enough room for context at 390px.
    // Use a genuinely constrained row to exercise the overflow-owned tooltip.
    await openComposer(page, 240, 300);
    await page.getByRole('button', { name: 'More composer options' }).click();
    const popover = page.getByRole('dialog', { name: 'Additional composer options' });
    await expect(popover).toBeVisible();
    const bounds = await popover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 0.5);
    expect(bounds.overflowY).toBe('auto');
    if (bounds.scrollHeight > bounds.clientHeight) {
      expect(bounds.clientHeight).toBeGreaterThan(0);
    }

    const contextIndicator = popover.locator('[data-toolbar-item="context-window"] [tabindex="0"]');
    await expect(contextIndicator).toBeVisible();
    await contextIndicator.scrollIntoViewIfNeeded();
    await contextIndicator.hover();
    const tooltip = page.locator('.pie-tooltip-host--rich:visible');
    await expect(tooltip).toBeVisible();
    const tooltipOwner = await tooltip.getAttribute('data-composer-toolbar-overflow-owner');
    const overflowOwner = await popover.getAttribute('data-composer-toolbar-overflow-owner');
    expect(tooltipOwner).toBeTruthy();
    expect(tooltipOwner).toBe(overflowOwner);

    const legendEntry = tooltip.locator('.ctx-legend-item').first();
    if (await legendEntry.count() > 0) await legendEntry.click();
    await expect(popover).toBeVisible();

    // Rich tooltips intentionally accept pointer input for chart inspection.
    // Dismiss that owned interactive surface explicitly before targeting the
    // adjacent toolbar control, rather than clicking through its hitbox.
    await contextIndicator.focus();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    // Escape may also dismiss the enclosing overflow panel; reopen it only
    // after the rich surface is gone so the next toolbar target is unobscured.
    if (!await popover.isVisible()) {
      await page.getByRole('button', { name: 'More composer options' }).click();
      await expect(popover).toBeVisible();
    }
    const browserTrigger = popover.getByRole('button', { name: 'Browser network access' });
    await browserTrigger.scrollIntoViewIfNeeded();
    await browserTrigger.click();
    const browserPopover = page.getByRole('dialog', { name: 'Browser network access' });
    await expect(browserPopover).toBeVisible();
    const nestedBounds = await browserPopover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    });
    expect(nestedBounds.top).toBeGreaterThanOrEqual(0);
    expect(nestedBounds.left).toBeGreaterThanOrEqual(0);
    expect(nestedBounds.right).toBeLessThanOrEqual(390);
    expect(nestedBounds.bottom).toBeLessThanOrEqual(300);
    await expect(popover).toBeVisible();
  });
});
