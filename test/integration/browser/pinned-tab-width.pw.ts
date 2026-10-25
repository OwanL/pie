// Real renderer, disposable host, illustrative session data only.
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { expect, test } from './ui-smoke-fixtures.js';
import type { SessionSummary } from '../../../application/lib/protocol/index.js';

const sessions: SessionSummary[] = [
  { path: '/fixture/pinned-alpha', name: 'Pinned Alpha', cwd: '/fixture', modifiedAt: '2026-10-25T12:00:00Z', messageCount: 1 },
  { path: '/fixture/pinned-beta', name: 'Pinned Beta', cwd: '/fixture', modifiedAt: '2026-10-25T12:00:00Z', messageCount: 1 },
  { path: '/fixture/normal', name: 'Normal Session', cwd: '/fixture', modifiedAt: '2026-10-25T12:00:00Z', messageCount: 1 },
];

const sessionByPath = new Map(sessions.map((session) => [session.path, session]));

async function captureScreenshot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const directory = process.env.PIE_PINNED_TAB_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

test.describe('pinned tab width in the real isolated renderer', () => {
  test.use({
    viewState: {
      sessions,
      openTabPaths: sessions.map(({ path: sessionPath }) => sessionPath),
      pinnedTabPaths: sessions.slice(0, 2).map(({ path: sessionPath }) => sessionPath),
      activeSession: sessions[2],
      activeSessionPath: sessions[2]!.path,
    },
  });

  test('keeps both pinned tabs at 40px and neighboring tabs stationary while selecting tabs', async ({ page, isolatedHost }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto('/');
    const strip = page.getByRole('tablist', { name: 'Sessions' });
    const pinned = strip.locator('.session-tab.pinned');
    const normal = strip.locator('.session-tab:not(.pinned)');
    await expect(pinned).toHaveCount(2);
    await expect(normal).toHaveCount(1);
    await expect(strip).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    await captureScreenshot(page, 'normal-active');

    const positions = async () => strip.locator('.session-tab').evaluateAll((tabs) => tabs.map((tab) => {
      const rect = tab.getBoundingClientRect();
      return { path: tab.getAttribute('data-tab-path'), left: rect.left, width: rect.width };
    }));
    const initial = await positions();
    const observations = [];

    for (const targetPath of [sessions[0]!.path, sessions[1]!.path, sessions[2]!.path]) {
      const tab = strip.locator(`.session-tab[data-tab-path="${targetPath}"]`);
      await tab.click();
      // Host selection is authoritative in production. Publish the selected
      // synthetic session after the real tab click, without a backend.
      isolatedHost.publishState({ activeSession: sessionByPath.get(targetPath), activeSessionPath: targetPath });
      await expect(tab).toHaveClass(/active/);
      const screenshotName = targetPath.split('/').at(-1)!;
      await captureScreenshot(page, screenshotName);
      const actual = await positions();
      observations.push({ selected: targetPath, tabs: actual });
    }

    for (const { selected, tabs } of observations) {
      for (const pinnedPath of sessions.slice(0, 2).map(({ path: sessionPath }) => sessionPath)) {
        const measured = tabs.find(({ path: itemPath }) => itemPath === pinnedPath)!;
        expect(measured.width, `pinned tab ${pinnedPath} width while selecting ${selected}`).toBe(40);
      }
      expect(tabs.map(({ path: itemPath, left }) => ({ path: itemPath, left })), `tab positions while selecting ${selected}`)
        .toEqual(initial.map(({ path: itemPath, left }) => ({ path: itemPath, left })));
    }
  });
});
