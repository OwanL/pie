// Playwright-only spec; the .pw.ts suffix keeps it out of pie's node:test discovery.
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ChatMessage } from '../../../application/lib/protocol/index.js';
import type { SubagentSingleResult } from '../../../harness/agent-processes/workers/subagent-result.js';

const TASK_END = 'SUBAGENT_TASK_END_7C4A';
const CONTEXT_END = 'INHERITED_PACKET_END_9B2D';
const LONG_MODEL = `runtimeModel${'UnbrokenModelIdentifier'.repeat(9)}`;
const LONG_REQUESTED_MODEL = `requestedModel${'LongRequestedModelIdentifier'.repeat(7)}`;

function longLines(prefix: string, lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `${prefix} ${index + 1}: ${'inherited-or-delegated-detail '.repeat(5)}`).join('\n');
}

const task = `Review the isolated browser tooltip layout and preserve every useful detail.\n${longLines('Delegated task detail', 26)}\n${TASK_END}`;
const parentUserContext = `[User prompt]\n${longLines('Parent prompt context', 24)}\n[Recorded clarification]\n${longLines('Recorded clarification detail', 18)}\n${CONTEXT_END}`;

const subagent: SubagentSingleResult = {
  agent: 'worker',
  task,
  exitCode: 0,
  messages: [],
  parentUserContextMode: 'all',
  parentUserContext,
  selectedModel: LONG_REQUESTED_MODEL,
  model: LONG_MODEL,
  provider: 'very-long-provider-identity-for-tooltip-layout-regression',
  thinkingLevel: 'high',
  contextWindow: 2_000_000_000,
  usage: {
    contextTokens: 1_234_567_890,
    input: 987_654_321,
    output: 87_654_321,
    cacheRead: 76_543_210,
    cacheWrite: 6_543_210,
    turns: 123,
    cost: 12_345.6789,
  },
  turnThroughputSamples: [{
    endedAt: '2026-09-30T12:00:00.000Z',
    outputTokens: 987_654,
    generationDurationMs: 128.5,
    status: 'completed',
  }],
};

const toolCall = {
  id: 'subagent-layout-regression',
  name: 'subagent',
  input: { agent: 'worker', task, userContext: 'all', model: LONG_REQUESTED_MODEL },
  result: { mode: 'single', results: [subagent] },
  status: 'completed' as const,
};
const transcript: ChatMessage[] = [{
  id: 'subagent-tooltip-transcript-row',
  role: 'assistant',
  createdAt: '2026-09-30T12:00:00.000Z',
  markdown: '',
  parts: [{ kind: 'toolCall', toolCall }],
  toolCalls: [toolCall],
  status: 'completed',
}];

test.describe('real subagent runtime tooltip layout in isolated Chromium', () => {
  test.use({
    viewState: {
      transcript,
      transcriptWindow: {
        ...EMPTY_VIEW_STATE.transcriptWindow,
        totalCount: 1,
        loadedEnd: 1,
        hasUserMessages: false,
      },
    },
  });

  test('keeps long task, inherited context, and runtime metrics inside one usable tooltip', async ({ page }) => {
    const viewports = [
      { width: 1280, height: 900, label: 'desktop' },
      { width: 320, height: 844, label: 'narrow phone' },
      { width: 390, height: 300, label: 'short viewport' },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');

      const trigger = page.locator('.subagent-model-details-trigger');
      await expect(trigger, `real subagent model trigger at ${viewport.label}`).toBeVisible();
      await trigger.hover();

      const tooltip = page.locator('body > .pie-tooltip-host--rich:visible');
      await expect(tooltip, `rich tooltip opens on hover at ${viewport.label}`).toBeVisible();
      const content = tooltip.locator('.subagent-model-details-tooltip');
      await expect(content).toBeVisible();
      await expect(content.locator('.subagent-context-tooltip-content')).toHaveCount(2);
      await expect(content).toContainText('Context handoff');
      await expect(content).toContainText('Delegated task');
      await expect(content).toContainText('Exact inherited parent context');
      await expect(content).toContainText('Usage & performance');

      const initialLayout = await content.evaluate((root) => {
        const rootRect = root.getBoundingClientRect();
        const hostRect = root.parentElement!.getBoundingClientRect();
        const firstMetric = root.querySelector<HTMLElement>('.subagent-detail-row');
        const firstMetricTop = firstMetric?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
        const taskTop = root.querySelector('.subagent-context-tooltip-content')!.getBoundingClientRect().top;
        const childrenOutsideBackground = Array.from(root.querySelectorAll<HTMLElement>('*'))
          .filter((element) => {
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || element.getClientRects().length === 0) return false;
            const rect = element.getBoundingClientRect();
            return rect.left < rootRect.left - 0.5 || rect.right > rootRect.right + 0.5;
          })
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            className: element.className.toString(),
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
          }));
        const rowOverlaps = Array.from(root.querySelectorAll<HTMLElement>('.subagent-detail-row')).flatMap((row) => {
          const cells = Array.from(row.children).map((cell) => cell.getBoundingClientRect());
          if (cells.length < 2) return [];
          const overlapX = Math.min(cells[0]!.right, cells.at(-1)!.right) - Math.max(cells[0]!.left, cells.at(-1)!.left);
          const overlapY = Math.min(cells[0]!.bottom, cells.at(-1)!.bottom) - Math.max(cells[0]!.top, cells.at(-1)!.top);
          return overlapX > 0.5 && overlapY > 0.5 ? [{ overlapX, overlapY }] : [];
        });
        const independentlyScrollableChildren = Array.from(root.querySelectorAll<HTMLElement>('*'))
          .filter((element) => {
            const style = getComputedStyle(element);
            return (style.overflowY === 'auto' || style.overflowY === 'scroll')
              && element.scrollHeight > element.clientHeight + 1;
          })
          .map((element) => element.className.toString());
        return {
          root: { left: rootRect.left, right: rootRect.right, top: rootRect.top, bottom: rootRect.bottom },
          host: { left: hostRect.left, right: hostRect.right, top: hostRect.top, bottom: hostRect.bottom },
          viewportWidth: window.innerWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          scrollHeight: root.scrollHeight,
          overflowY: getComputedStyle(root).overflowY,
          firstMetricOffset: firstMetricTop - rootRect.top,
          taskOffset: taskTop - rootRect.top,
          childrenOutsideBackground,
          rowOverlaps,
          independentlyScrollableChildren,
        };
      });

      expect(initialLayout.host.left, `${viewport.label}: tooltip background left bound`).toBeGreaterThanOrEqual(-0.5);
      expect(initialLayout.host.right, `${viewport.label}: tooltip background right bound`).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(initialLayout.host.top, `${viewport.label}: tooltip background top bound`).toBeGreaterThanOrEqual(0);
      expect(initialLayout.host.bottom, `${viewport.label}: tooltip background bottom bound`).toBeLessThanOrEqual(viewport.height);
      expect(initialLayout.root.left, `${viewport.label}: tooltip content left bound`).toBeGreaterThanOrEqual(initialLayout.host.left - 0.5);
      expect(initialLayout.root.right, `${viewport.label}: tooltip content right bound`).toBeLessThanOrEqual(initialLayout.host.right + 0.5);
      expect(initialLayout.childrenOutsideBackground, `${viewport.label}: tooltip children stay inside the background`).toEqual([]);
      expect(initialLayout.scrollWidth, `${viewport.label}: tooltip has no horizontal overflow`).toBeLessThanOrEqual(initialLayout.clientWidth + 1);
      expect(initialLayout.documentScrollWidth, `${viewport.label}: page has no tooltip-induced horizontal scrolling`).toBeLessThanOrEqual(initialLayout.viewportWidth);
      expect(initialLayout.overflowY, `${viewport.label}: tooltip content has a vertical scroll surface`).toMatch(/^(auto|scroll)$/);
      expect(initialLayout.scrollHeight, `${viewport.label}: long task and inherited packet require vertical scrolling`).toBeGreaterThan(await content.evaluate((root) => root.clientHeight));
      // Pathological model identifiers wrap to many lines; priority is ordering,
      // not a fixed pixel offset from those variable-height identity lines.
      expect(initialLayout.firstMetricOffset, `${viewport.label}: primary metrics precede task detail`).toBeLessThan(initialLayout.taskOffset);
      expect(initialLayout.rowOverlaps, `${viewport.label}: metric labels and values do not overlap`).toEqual([]);
      expect(initialLayout.independentlyScrollableChildren, `${viewport.label}: content uses one vertical scroll surface`).toEqual([]);

      const contentBlocks = content.locator('.subagent-context-tooltip-content');
      const taskBlock = contentBlocks.nth(0);
      const contextBlock = contentBlocks.nth(1);
      await expect(taskBlock).toContainText(TASK_END);
      await expect(contextBlock).toContainText(CONTEXT_END);

      // Put the pointer on the rich tooltip, scroll through the task, then the
      // inherited packet. The same tooltip-owned scroller must reveal both ends
      // without dismissing the fixed host as its own scroll position changes.
      await content.hover();
      await content.evaluate((root) => {
        const taskElement = root.querySelectorAll<HTMLElement>('.subagent-context-tooltip-content')[0]!;
        root.scrollTop = Math.max(0, taskElement.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom + root.scrollTop + 4);
      });
      const taskEndVisible = await content.evaluate((root) => {
        const markerRect = (marker: string) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const index = node.textContent?.lastIndexOf(marker) ?? -1;
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + marker.length);
            const rect = range.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }
          return undefined;
        };
        const end = markerRect('SUBAGENT_TASK_END_7C4A');
        const clip = root.getBoundingClientRect();
        return !!end && end.bottom <= clip.bottom - 1 && end.top >= clip.top - 1;
      });
      expect(taskEndVisible, `${viewport.label}: the full delegated task is reachable by scrolling`).toBe(true);
      await expect(tooltip, `${viewport.label}: tooltip stays open while its content is scrolled`).toBeVisible();

      await content.evaluate((root) => { root.scrollTop = root.scrollHeight; });
      const contextEndVisible = await content.evaluate((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let end: { top: number; bottom: number } | undefined;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const marker = 'INHERITED_PACKET_END_9B2D';
          const index = node.textContent?.lastIndexOf(marker) ?? -1;
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + marker.length);
          const rect = range.getBoundingClientRect();
          end = { top: rect.top, bottom: rect.bottom };
          break;
        }
        const clip = root.getBoundingClientRect();
        return !!end && end.bottom <= clip.bottom - 1 && end.top >= clip.top - 1;
      });
      expect(contextEndVisible, `${viewport.label}: the full inherited packet is reachable by the same scroll`).toBe(true);
      await expect(tooltip, `${viewport.label}: tooltip remains open at the bottom of its scroll range`).toBeVisible();

      if (viewport.label === 'desktop') {
        await page.mouse.move(1, 1);
        await expect(tooltip).toBeHidden();
        await trigger.focus();
        await expect(trigger).toBeFocused();
        await expect(tooltip, 'keyboard focus opens the runtime tooltip').toBeVisible();
        await page.keyboard.press('Escape');
        await expect(tooltip, 'Escape dismisses the keyboard-opened tooltip').toBeHidden();
      }
    }
  });
});
