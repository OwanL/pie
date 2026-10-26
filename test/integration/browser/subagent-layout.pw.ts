// Real renderer, disposable host, illustrative data only: no SDK or provider calls.
import type { Locator } from '@playwright/test';
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ChatMessage } from '../../../application/lib/protocol/index.js';
import { normalizeToolProgress } from '../../../harness/agent-processes/workers/tool-progress-normalizer.js';
import type { SubagentSingleResult } from '../../../harness/agent-processes/workers/subagent-result.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const children: SubagentSingleResult[] = [
  {
    agent: 'scout', task: 'Trace refresh cancellation', model: 'fixture/GPT-6 Luna', thinkingLevel: 'high',
    exitCode: -1, activityPhase: 'waiting_provider', startedAt: NOW - 102_000,
    activitySince: NOW - 4_000, contextWindow: 128_000,
    usage: { contextTokens: 18_000, cost: 0.08 }, messages: [],
  },
  {
    agent: 'worker', task: 'Verify cancellation isolation', model: 'fixture/GPT-6 Astra', thinkingLevel: 'medium',
    exitCode: -1, activityPhase: 'streaming', startedAt: NOW - 138_000,
    activitySince: NOW - 2_000, contextWindow: 128_000,
    streamingText: '14 tests passed; investigating the remaining AbortError.',
    usage: { contextTokens: 41_000, cost: 0.12 }, messages: [],
  },
  {
    agent: 'reviewer', task: 'Review shared refresh ownership', model: 'fixture/GPT-6.1 Sol', thinkingLevel: 'high',
    exitCode: 0, activityPhase: 'completed', startedAt: NOW - 100_000,
    completedAt: NOW - 42_000, contextWindow: 200_000,
    usage: { contextTokens: 24_000, cost: 0.06 },
    finalOutput: 'Shared refresh inherits a caller’s signal. Give the shared refresh its own cancellation scope.',
    messages: [{ role: 'assistant', content: 'Give the shared refresh its own cancellation scope.', timestamp: NOW - 42_000 }],
  },
];

function state(results = children, seq = 0, normalized = false) {
  const toolCall = {
    id: 'illustrative-auth-delegation', name: 'subagent', status: 'running' as const, seq,
    input: { tasks: results.map(({ agent, task }) => ({ agent, task })) },
    result: normalized ? normalizeToolProgress('subagent', { mode: 'parallel', results }) : { mode: 'parallel', results },
  };
  const transcript: ChatMessage[] = [{
    id: 'illustrative-auth-review', role: 'assistant', createdAt: new Date(NOW).toISOString(),
    markdown: '', parts: [{ kind: 'toolCall', toolCall }], toolCalls: [toolCall], status: 'streaming',
  }];
  return {
    transcript,
    transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 1, loadedEnd: 1, hasUserMessages: false },
  };
}

const card = (root: Locator, role: string) => root.locator('.tool-call-subagent').filter({ has: root.page().getByRole('button', { name: `Toggle ${role} subagent`, exact: true }) });
const header = (root: Locator) => root.locator('.subagent-header');

async function textFragments(locator: Locator) {
  return locator.evaluateAll((elements) => elements.flatMap((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects(), (rect) => ({
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    })).filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  }));
}

async function expectContained(root: Locator) {
  const overflow = await root.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const metrics = Array.from(element.querySelectorAll<HTMLElement>('.subagent-model-label, .subagent-header-metrics, .subagent-inline-context, .subagent-telemetry-cost, .subagent-telemetry-elapsed'));
    return {
      left: rect.left, right: rect.right, width: innerWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      clipped: metrics.filter((metric) => {
        // display:contents participates in layout through its children only.
        if (getComputedStyle(metric).display === 'contents') return false;
        const bounds = metric.getBoundingClientRect();
        return bounds.left < rect.left - 1 || bounds.right > rect.right + 1 || metric.scrollWidth > metric.clientWidth + 1;
      }).map((metric) => metric.className),
    };
  });
  expect(overflow.left).toBeGreaterThanOrEqual(0);
  expect(overflow.right).toBeLessThanOrEqual(overflow.width);
  expect(overflow.pageOverflow).toBeLessThanOrEqual(1);
  expect(overflow.clipped).toEqual([]);
}

test.describe('subagent redesign in the real isolated renderer', () => {
  test.use({ viewState: state() });

  test('keeps known metadata readable at phone, sidebar, desktop and short sizes', async ({ page }, info) => {
    await page.clock.setFixedTime(NOW);
    // OS color-scheme media is not Pie's theme setting.
    for (const [width, height] of [[320, 844], [420, 900], [520, 900], [1280, 720], [390, 300]] as const) {
        await page.setViewportSize({ width, height });
        await page.goto('/');
        const cards = page.locator('.tool-call-subagent');
        await expect(cards).toHaveCount(3);
        for (const [index, expected] of [
          ['18k/128k', '$0.08', '1:42'], ['41k/128k', '$0.12', '2:18'], ['24k/200k', '$0.06', '0:58'],
        ].entries()) {
          const item = cards.nth(index);
          await item.scrollIntoViewIfNeeded();
          for (const text of expected) await expect(header(item)).toContainText(text);
          await expect(item.locator('.subagent-role-icon')).toHaveAttribute('data-role-icon', children[index]!.agent);
          await expect(item.locator('.subagent-role-icon')).toHaveAttribute('stroke-width', '1.2');
          const model = item.locator('.subagent-model-short');
          const reasoning = item.locator('.subagent-model-reasoning');
          await expect(model).toHaveCSS('font-size', '12px');
          await expect(model).toHaveCSS('font-weight', '500');
          await expect(model).toHaveCSS('line-height', '18px');
          const level = children[index]!.thinkingLevel;
          if (level) {
            await expect(reasoning).toHaveText(level);
            for (const property of ['font-size', 'font-weight', 'line-height', 'vertical-align']) {
              await expect(reasoning).toHaveCSS(property, await model.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property));
            }
          }
          else await expect(reasoning).toHaveCount(0);
          await expectContained(item);
        }
        if (width === 420 || width === 520) {
          await cards.first().scrollIntoViewIfNeeded();
          await page.mouse.move(0, 0);
          await page.evaluate(() => document.fonts.ready);
          const screenshot = info.outputPath(`subagents-${width}.png`);
          await page.screenshot({ path: screenshot });
          await info.attach(`subagents-${width}`, { path: screenshot, contentType: 'image/png' });
        }
    }
  });

  test('supports independent mouse and keyboard expansion without tooltip or body toggles', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 900 });
    await page.goto('/');
    const root = page.locator('body');
    const scout = card(root, 'scout');
    const reviewer = card(root, 'reviewer');
    await expect(header(scout)).toHaveAttribute('aria-expanded', 'false');
    const model = scout.locator('.subagent-model-details-trigger');
    await model.click();
    await expect(header(scout)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('body > .pie-tooltip-host--rich:visible')).toBeVisible();
    await model.press('Enter');
    await model.press('Space');
    await expect(header(scout)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    const role = scout.getByLabel('Inspect scout model exchange', { exact: true });
    await role.click();
    await expect(header(scout)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await header(scout).click();
    await expect(header(scout)).toHaveAttribute('aria-expanded', 'true');
    await expect(header(reviewer)).toHaveAttribute('aria-expanded', 'false');
    await header(reviewer).focus();
    await page.keyboard.press('Enter');
    await expect(header(reviewer)).toHaveAttribute('aria-expanded', 'true');
    const body = reviewer.locator('.subagent-messages').first();
    await body.click();
    await body.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await body.click();
    await expect(header(reviewer)).toHaveAttribute('aria-expanded', 'true');
    await header(reviewer).focus();
    await page.keyboard.press('Space');
    await expect(header(reviewer)).toHaveAttribute('aria-expanded', 'false');
    await expect(header(scout)).toHaveAttribute('aria-expanded', 'true');
  });

  test('renders host lifecycle updates without losing disclosure state', async ({ page, isolatedHost }) => {
    await page.clock.install({ time: NOW });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    const scout = card(page.locator('body'), 'scout');
    const reviewer = card(page.locator('body'), 'reviewer');
    await expect(header(scout)).toHaveAttribute('aria-expanded', 'false');
    await header(reviewer).focus();
    await page.keyboard.press('Enter');
    await expect(header(reviewer)).toHaveAttribute('aria-expanded', 'true');

    let current = { ...children[0]! };
    let seq = 0;
    const publish = (patch: Partial<SubagentSingleResult>) => {
      current = { ...current, ...patch };
      // ToolCallRenderer memoization keys on seq, just as real host updates do.
      isolatedHost.publishState(state([current, children[1]!, children[2]!], ++seq));
    };
    const disclosuresUnchanged = async () => {
      await expect(header(scout)).toHaveAttribute('aria-expanded', 'false');
      await expect(header(reviewer)).toHaveAttribute('aria-expanded', 'true');
    };

    publish({ activityPhase: 'waiting_provider', activityDetail: 'Waiting for isolated fixture provider' });
    await expect(scout).toContainText('Waiting for isolated fixture provider');
    await disclosuresUnchanged();
    publish({ activityPhase: 'streaming', activityDetail: undefined, streamingReasoning: 'Tracing the cancellation boundary' });
    await expect(scout).toContainText('Tracing the cancellation boundary');
    await disclosuresUnchanged();
    publish({ streamingReasoning: undefined, streamingText: 'Live stale cancellation draft' });
    await expect(scout).toContainText('Live stale cancellation draft');
    await disclosuresUnchanged();
    publish({ activityPhase: 'running_tool', runningTools: ['read'], messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'fixture-read', name: 'read', arguments: { path: 'cancellation-scope.ts' } }] },
    ] });
    await expect(scout).toContainText('cancellation-scope.ts');
    await disclosuresUnchanged();
    await page.clock.runFor(3_000);
    publish({ exitCode: 0, activityPhase: 'completed', completedAt: NOW + 3_000, runningTools: [],
      finalOutput: 'Unqualified fallback must not replace the answer',
      messages: [{ role: 'assistant', content: 'Final answer: give shared refresh its own cancellation scope.' }],
    });
    await expect(scout).toContainText('Final answer: give shared refresh its own cancellation scope.');
    await expect(scout).not.toContainText('Live stale cancellation draft');
    await expect(scout).not.toContainText('Unqualified fallback');
    await disclosuresUnchanged();
    await expect(scout.locator('.subagent-telemetry-elapsed')).toHaveText('1:45');
    await page.clock.runFor(60_000);
    await expect(scout.locator('.subagent-telemetry-elapsed')).toHaveText('1:45');
    await expectContained(scout);
  });

  test('advances live elapsed time but freezes completed duration', async ({ page }) => {
    await page.clock.install({ time: NOW });
    await page.goto('/');
    const elapsed = page.locator('.subagent-telemetry-elapsed');
    await expect(elapsed.nth(0)).toHaveText('1:42');
    await expect(elapsed.nth(2)).toHaveText('0:58');
    await page.clock.runFor(3_000);
    await expect(elapsed.nth(0)).toHaveText('1:45');
    await expect(elapsed.nth(1)).toHaveText('2:21');
    await expect(elapsed.nth(2)).toHaveText('0:58');
  });
});

test.describe('bounded live subagent preview', () => {
  const usage = { input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0 };
  const child = { ...children[0]!, model: 'fixture/Model', provider: 'fixture',
    usage: { ...usage, contextTokens: 18_000, turns: 2 },
    providerInvocations: [0, 1].map((index) => ({ invocationId: `response-${index}`, model: 'Model', provider: 'fixture', usage })),
  };
  test.use({ viewState: { ...state([child], 0, true), availableModels: [{
    id: 'Model', name: 'Model', provider: 'fixture', reasoning: false, inputKinds: ['text'],
    subagent: { eligible: true, pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  }] } });

  test('renders compact markdown in live previews and settled outcomes without changing transcript or tool text', async ({ page, isolatedHost }, info) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    const item = page.locator('.tool-call-subagent');
    const liveMarkdown = '# **Reasoning label**\nA *careful* `scope`\nNext line\n- **Caller** remains independent\n- Shared refresh is separate';
    let seq = 0;
    const publish = (patch: Partial<SubagentSingleResult>) => {
      isolatedHost.publishState(state([{ ...child, ...patch }], ++seq));
    };

    publish({ activityPhase: 'streaming', streamingReasoning: liveMarkdown });
    const currentText = item.locator('.subagent-current-text');
    const preview = item.locator('.subagent-current-text.subagent-preview-markdown');
    await expect(preview).toBeVisible();
    await expect(preview.locator('p > strong')).toContainText('Reasoning label');
    await expect(preview.locator('em')).toContainText('careful');
    await expect(preview.locator('code')).toContainText('scope');
    await expect(preview.locator('li')).toHaveCount(2);
    await expect(preview.locator('h1,h2,h3,h4,h5,h6')).toHaveCount(0);
    expect(await item.locator('.subagent-current').evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(72);
    await expect(preview.locator('br')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('compact-live-markdown.png') });

    const replyMarkdown = '## **Reply label**\nUse `pnpm test`\n- **Passed**\n- *No leaks*';
    publish({ streamingReasoning: undefined, streamingText: replyMarkdown });
    await expect(currentText.locator('p > strong')).toContainText('Reply label');
    await expect(currentText.locator('code')).toHaveText('pnpm test');

    const literalCommand = 'echo **not markdown**';
    const literalOutput = '**still literal**\n- not a rendered list';
    const toolCall = { role: 'assistant', content: [{ type: 'toolCall', id: 'markdown-literal', name: 'bash', arguments: { command: literalCommand },
      result: { content: [{ type: 'text', text: literalOutput }] },
    }] };
    publish({ activityPhase: 'running_tool', streamingText: undefined, runningTools: ['bash'], messages: [toolCall] });
    await expect(item.locator('.subagent-current-input')).toHaveText(literalCommand);
    await expect(item.locator('.subagent-current-output')).toHaveText(literalOutput);
    await expect(item.locator('.subagent-current-input strong, .subagent-current-output strong, .subagent-current-output li')).toHaveCount(0);

    const outcomeMarkdown = '# **Outcome label**\nA *compact* `answer`\n- **Shared work**\n- Independent callers';
    publish({ exitCode: 0, activityPhase: 'completed', completedAt: NOW, runningTools: [], messages: [
      { role: 'assistant', content: outcomeMarkdown, timestamp: NOW },
    ], finalOutput: outcomeMarkdown });
    const outcomePreview = item.locator('.subagent-outcome.subagent-preview-markdown');
    await expect(outcomePreview.locator('p > strong')).toContainText('Outcome label');
    await expect(outcomePreview.locator('em')).toContainText('compact');
    await expect(outcomePreview.locator('code')).toContainText('answer');
    await expect(outcomePreview.locator('li')).toHaveCount(2);
    await expect(outcomePreview.locator('h1,h2,h3,h4,h5,h6')).toHaveCount(0);
    const outcomeFitsSixLines = await outcomePreview.evaluate((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return element.getBoundingClientRect().height <= lineHeight * 6 + 18;
    });
    expect(outcomeFitsSixLines).toBe(true);

    for (const width of [320, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await expectContained(item);
      await page.screenshot({ path: info.outputPath(`compact-outcome-${width}.png`) });
    }
    await header(item).click();
    await expect(item.locator('.subagent-messages h1')).toContainText('Outcome label');
  });

  test('keeps a dense header and stable live viewport while exposing commands, output and cost', async ({ page, isolatedHost }, info) => {
    await page.clock.setFixedTime(NOW);
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    const item = page.locator('.tool-call-subagent');
    await expect(item).toHaveCount(1);
    const heights: number[] = [];
    let current: SubagentSingleResult = child;
    let seq = 0;
    const publish = async (patch: Partial<SubagentSingleResult>, expected: string, screenshot?: string) => {
      current = { ...current, ...patch };
      isolatedHost.publishState(state([current], ++seq, true));
      await expect(item).toContainText(expected);
      await page.evaluate(() => document.fonts.ready);
      heights.push((await item.boundingBox())!.height);
      if (screenshot) await page.screenshot({ path: info.outputPath(`${screenshot}.png`) });
    };
    await publish({ activityDetail: 'Waiting for fixture provider' }, 'Waiting for fixture provider');
    await publish({ activityPhase: 'streaming', activityDetail: undefined, streamingReasoning: 'Inspecting the cancellation owner.' }, 'Inspecting the cancellation owner.');
    await publish({ streamingReasoning: 'Inspecting shared cancellation ownership and independent caller lifetimes. '.repeat(12) }, 'Inspecting shared cancellation', 'live-reasoning');
    const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'live-bash', name: 'bash', arguments: { command: 'pnpm test -- cancellation' },
      result: { content: [{ type: 'text', text: 'Checking cancellation scope…\n12 tests passed\nNo leaked listeners' }] },
    }] };
    await publish({ activityPhase: 'running_tool', runningTools: ['bash'], streamingReasoning: undefined, messages: [call] }, 'bash', 'live-tool');
    // A real normalized preview has no transcript messages. Its bounded fields
    // must carry both current activity and per-response cost through rendering.
    await expect(item.locator('.subagent-current-input')).toHaveText('pnpm test -- cancellation');
    await expect(item.locator('.subagent-current-output')).toContainText('No leaked listeners');
    await expect(item.locator('.subagent-telemetry-cost')).toHaveText('~$0.02');
    const headerHeight = (await header(item).boundingBox())!.height;
    expect(headerHeight).toBeGreaterThanOrEqual(32);
    expect(headerHeight).toBeLessThanOrEqual(34);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    await expectContained(item);
  });
});

// Check hierarchy by contrast rather than pinning tests to a palette.
test.describe('subagent card hierarchy', () => {
  const reviewAnswer = [
    'First paragraph states the finding in plain prose so the preview base layer stays muted.',
    '',
    '## Section heading row',
    '- Highlighted **emphasis detail** with an `inline code` marker',
    '- Another bullet keeps the preview occupying more than one row',
    '',
    '## Trailing heading',
    'Closing paragraph after two sections keeps the clamp engaged on every width under test.',
  ].join('\n');
  const longTask = `${'Single-line delegated instruction that is deliberately long enough to overflow a one-row preview. '.repeat(3)}END_OF_TASK_9C1D`;
  const hierarchyChildren: SubagentSingleResult[] = [{
    agent: 'reviewer', task: longTask, model: 'fixture/GPT-6.1 Sol', thinkingLevel: 'low',
    exitCode: 0, activityPhase: 'completed', startedAt: NOW - 60_000, completedAt: NOW,
    contextWindow: 200_000, usage: { contextTokens: 24_000, cost: 0.06 },
    finalOutput: reviewAnswer, messages: [{ role: 'assistant', content: reviewAnswer, timestamp: NOW }],
  }];
  test.use({ viewState: state(hierarchyChildren) });

  test('orders the header above task above preview by contrast, not palette', async ({ page }, info) => {
    const card = page.locator('.tool-call-subagent');
    for (const [index, [width, height]] of [[440, 900] as const, [1100, 900] as const].entries()) {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(card).toHaveCount(1);
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      const hierarchy = await page.evaluate(() => {
        const srgb = (value: number) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (color: string) => {
          const match = color.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
          if (!match || (match[4] !== undefined && Number(match[4]) < 1)) throw new Error(`not opaque: ${color}`);
          return 0.2126 * srgb(Number(match[1])) + 0.7152 * srgb(Number(match[2])) + 0.0726 * srgb(Number(match[3]));
        };
        const contrast = (foreground: string, background: string) => {
          const a = luminance(foreground), b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const root = document.querySelector('.tool-call-subagent')!;
        const header = root.querySelector('.subagent-header');
        const headerBg = getComputedStyle(header!).backgroundColor;
        const cardBg = getComputedStyle(root).backgroundColor;
        const firstStrong = root.querySelector('.subagent-outcome strong');
        const plainParagraph = root.querySelector('.subagent-outcome p:not(:has(strong:only-child))');
        return {
          main: contrast(getComputedStyle(root.querySelector('.subagent-model-short')!).color, headerBg),
          icon: contrast(getComputedStyle(root.querySelector('.subagent-role-icon')!).color, headerBg),
          task: contrast(getComputedStyle(root.querySelector('.subagent-task')!).color, cardBg),
          strong: contrast(getComputedStyle(firstStrong!).color, cardBg),
          preview: contrast(getComputedStyle(plainParagraph!).color, cardBg),
          headerContrastsWithCard: headerBg !== cardBg,
        };
      });
      // Header identity outranks task text, which outranks both the preview
      // base layer and its stepped-up emphasis; the icon stays legible.
      expect(hierarchy.main).toBeGreaterThan(hierarchy.task);
      expect(hierarchy.task).toBeGreaterThan(hierarchy.strong);
      expect(hierarchy.strong).toBeGreaterThan(hierarchy.preview);
      expect(hierarchy.icon).toBeGreaterThan(3);
      expect(hierarchy.headerContrastsWithCard).toBe(true);
      if (index === 1) {
        const screenshot = info.outputPath('approved-hierarchy-1100.png');
        await page.screenshot({ path: screenshot });
        await info.attach('approved-hierarchy-1100', { path: screenshot, contentType: 'image/png' });
      }
    }
  });

  test('keeps a long task on one row with the full text only a tooltip away', async ({ page }) => {
    await page.setViewportSize({ width: 440, height: 900 });
    await page.goto('/');
    const task = page.locator('.subagent-task').first();
    await expect(task).toBeVisible();
    const oneRow = await task.locator('.subagent-task-excerpt').evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height, lineHeight: style.lineHeight, overflow: style.overflow,
        ellipsis: style.textOverflow, nowrap: style.whiteSpace, truncated: element.scrollWidth > element.clientWidth,
      };
    });
    expect(oneRow.height).toBeLessThanOrEqual(Number.parseFloat(oneRow.lineHeight) + 1);
    expect(oneRow.overflow).toBe('hidden');
    expect(oneRow.ellipsis).toBe('ellipsis');
    expect(oneRow.nowrap).toBe('nowrap');
    expect(oneRow.truncated).toBe(true);
    await task.hover();
    const tooltip = page.locator('.subagent-task-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(longTask);
    await expect(tooltip).toContainText('END_OF_TASK_9C1D');
    // Keyboard access reaches the very same popover.
    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
    await task.focus();
    await expect(tooltip, 'keyboard focus opens the full task tooltip').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
  });

  test('waits 200ms before opening the prompt on hover', async ({ page }) => {
    await page.goto('/');
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.locator('.subagent-task').hover();
    const prompt = page.locator('.subagent-task-tooltip');
    await page.clock.runFor(199);
    await expect(prompt).toBeHidden();
    // Flush the renderer's next animation frame after the hover timer.
    await page.clock.runFor(20);
    await expect(prompt).toBeVisible();
  });

  for (const [width, height] of [[320, 844], [420, 900], [1100, 900], [420, 240]] as const) {
    test(`anchors and bounds the prompt inspector at ${width}x${height}, with a pointer bridge and scrollable end`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      const task = page.locator('.subagent-task');
      await task.scrollIntoViewIfNeeded();
      await task.hover();
      const popup = page.locator('.pie-tooltip-host:has(.subagent-task-popover)');
      const prompt = popup.locator('.subagent-task-tooltip');
      await expect(popup).toBeVisible();
      await expect(prompt).toHaveText(longTask);
      const trigger = (await task.boundingBox())!;
      const bounds = (await popup.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(5);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 5);
      expect(bounds.y).toBeGreaterThanOrEqual(5);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 5);
      // Start aligned where it fits; otherwise clamp, rather than centering.
      expect(bounds.x).toBeCloseTo(Math.max(6, Math.min(trigger.x, width - bounds.width - 6)), 0);
      expect(bounds.y >= trigger.y + trigger.height || bounds.y + bounds.height <= trigger.y).toBe(true);
      // Cross the real six-pixel bridge, then remain over the popup longer
      // than its hide delay: hovering the host must cancel dismissal.
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 10, { steps: 5 });
      await page.waitForTimeout(300);
      await expect(popup).toBeVisible();
      await prompt.hover();
      await page.mouse.wheel(0, 2000);
      await expect.poll(() => prompt.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
      const endVisible = await prompt.evaluate((element) => {
        const text = element.firstChild!;
        const range = document.createRange();
        range.setStart(text, text.textContent!.indexOf('END_OF_TASK_9C1D'));
        range.setEnd(text, text.textContent!.length);
        const end = range.getBoundingClientRect(), box = element.getBoundingClientRect();
        return end.top >= box.top && end.bottom <= box.bottom;
      });
      expect(endVisible).toBe(true);
      if (height === 240) expect(await prompt.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    });
  }

  for (const denied of [false, true]) {
    test(`copies the exact raw prompt with ${denied ? 'denied' : 'success'} feedback and keyboard return`, async ({ page }) => {
      await page.addInitScript((deny) => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async (text: string) => {
            (window as unknown as { copiedPrompt: string }).copiedPrompt = text;
            if (deny) throw new DOMException('Fixture clipboard denied', 'NotAllowedError');
          },
        } });
      }, denied);
      await page.setViewportSize({ width: 420, height: 240 });
      await page.goto('/');
      const task = page.locator('.subagent-task');
      await task.focus();
      const popup = page.locator('.pie-tooltip-host:has(.subagent-task-popover)');
      const copy = popup.getByRole('button', { name: 'Copy delegated prompt' });
      const prompt = popup.locator('.subagent-task-tooltip');
      await expect(popup).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(copy).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(copy).toHaveText(denied ? 'Copy failed' : 'Copied');
      await expect(popup.getByRole('status')).toHaveText(denied ? 'Copy failed' : 'Copied');
      expect(await page.evaluate(() => (window as unknown as { copiedPrompt: string }).copiedPrompt)).toBe(longTask);
      await page.keyboard.press('Tab');
      await expect(prompt).toBeFocused();
      expect(await prompt.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await page.keyboard.press('Control+End');
      await expect.poll(() => prompt.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect(popup).toBeHidden();
      await expect(task).toBeFocused();
      await expect(page.locator('.subagent-header')).toHaveAttribute('aria-expanded', 'false');
    });
  }

  test('bounds settled and live previews to fixed budgets across widths', async ({ page, isolatedHost }, info) => {
    const item = page.locator('.tool-call-subagent');
    for (const width of [320, 440, 1100] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const outcome = item.locator('.subagent-outcome.subagent-preview-markdown');
      await expect(outcome).toBeVisible();
      await item.scrollIntoViewIfNeeded();
      await expect(outcome.locator('p > strong').first()).toContainText('Section heading row');
      await expect(outcome.locator('strong').filter({ hasText: 'emphasis detail' })).toBeVisible();
      await expect(outcome.locator('code')).toContainText('inline code');
      await expect(outcome.locator('li')).toHaveCount(2);
      await expect(outcome.locator('h1,h2,h3,h4,h5,h6')).toHaveCount(0);
      const bounds = await outcome.evaluate((element) => ({
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight), height: getComputedStyle(element).height,
      }));
      // CSS-only line clamp: no measuring script, integer row budget. Paragraph
      // margins between the clamped rows add a small, bounded slack on top of
      // the six 18px line boxes.
      expect(Number.parseFloat(bounds.height)).toBeLessThanOrEqual(bounds.lineHeight * 6 + 30);
      await expectContained(item);
    }
    // The live viewport keeps its 72px budget while markdown streams.
    let seq = 0;
    isolatedHost.publishState(state([{ ...hierarchyChildren[0]!, exitCode: -1, completedAt: undefined, activityPhase: 'streaming', streamingText: '# Streaming **markdown** preview\nNext `line`' }], ++seq));
    await expect(item.locator('.subagent-current-text.subagent-preview-markdown')).toBeVisible();
    expect(await item.locator('.subagent-current').evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(72);
    await page.screenshot({ path: info.outputPath('bounded-live-72px.png') });
  });
});

test.describe('terminal subagent diagnostics', () => {
  test.use({ viewState: state([
    { ...children[0]!, exitCode: 1, activityPhase: 'failed', completedAt: NOW, errorMessage: 'Illustrative refresh test failed', finalOutput: 'Cancellation isolation assertion failed.' },
    { ...children[1]!, exitCode: 1, activityPhase: 'cancelled', stopReason: 'aborted', completedAt: NOW, streamingText: undefined, errorMessage: 'Illustrative user interruption' },
  ]) });
  test('retains failure and interruption diagnostics', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tool-call-subagent.failed')).toHaveCount(1);
    await expect(page.locator('.tool-call-subagent.interrupted')).toHaveCount(1);
    const model = page.locator('.subagent-model-details-trigger').first();
    await model.focus();
    await expect(page.locator('body > .pie-tooltip-host--rich:visible')).toContainText('Illustrative refresh test failed');
  });
});

// Exercise real nested cards and unusually large/unknown telemetry, not just
// the short labels used in the approved illustrative screenshot.
test.describe('subagent layout under constrained touch widths', () => {
  test.use({ hasTouch: true, viewState: state([
    {
      ...children[0]!, model: `fixture/GPT-6-Astra-${'long-model-identifier-'.repeat(5)}`, thinkingLevel: 'xhigh',
      exitCode: 0, activityPhase: 'completed', startedAt: NOW - 3_723_000, completedAt: NOW,
      contextWindow: 2_000_000_000, usage: { contextTokens: 1_234_567, cost: 12345.6789 },
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'nested-review', name: 'subagent', arguments: { agent: 'reviewer', task: children[2]!.task } }] },
        { role: 'toolResult', toolCallId: 'nested-review', toolName: 'subagent', details: { results: [children[2]!] }, content: [] },
      ],
    },
    { agent: 'custom-auditor', task: 'Await model selection', exitCode: -1, activityPhase: 'queued', messages: [] },
  ]) });
  test('wraps long identities and whole metric groups while nested controls stay reachable', async ({ page }, info) => {
    await page.clock.setFixedTime(NOW);
    for (const width of [320, 420, 800]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      const parent = page.locator('.tool-call-subagent').first();
      await expect(parent.locator('.subagent-header').first()).toContainText('1.2m/2b');
      await expect(parent.locator('.subagent-header').first()).toContainText('$12345.68');
      await expect(parent.locator('.subagent-header').first()).toContainText('62:03');
      await expectContained(parent);
      const unknown = card(page.locator('body'), 'custom-auditor');
      await expect(header(unknown)).toContainText('Model unavailable');
      await expect(header(unknown).locator('.subagent-model-reasoning')).toHaveCount(0);
      const reasoning = parent.locator('.subagent-model-reasoning').first();
      await expect(reasoning).toHaveText('xhigh');
      await page.evaluate(() => document.fonts.ready);
      // Inline bounding boxes union wrapped lines, including empty space between
      // fragments. Compare rendered text instead, for both identity spans.
      const identityFragments = await textFragments(parent.locator('.subagent-header').first().locator('.subagent-model-short, .subagent-model-reasoning'));
      expect(identityFragments.length).toBeGreaterThan(0);
      for (const metric of await parent.locator('.subagent-header').first().locator('.subagent-inline-context, .subagent-telemetry-cost, .subagent-telemetry-elapsed').all()) {
        const metricFragments = await textFragments(metric);
        expect(metricFragments.length).toBeGreaterThan(0);
        const intersects = identityFragments.some((identity) => metricFragments.some((bounds) =>
          identity.left < bounds.right && identity.right > bounds.left
          && identity.top < bounds.bottom && identity.bottom > bounds.top));
        expect(intersects, `identity text must clear ${await metric.getAttribute('class')} at ${width}px`).toBe(false);
      }
      await page.mouse.move(0, 0);
      await page.screenshot({ path: info.outputPath(`unknown-telemetry-${width}.png`) });
      await expect(header(unknown)).not.toContainText('—');
      await expect(unknown.locator('.subagent-inline-context')).toHaveCount(0);
      await expect(unknown.locator('.subagent-telemetry-cost')).toHaveCount(0);
      await expect(unknown.locator('.subagent-header-metrics')).toBeEmpty();
      await expect(unknown.locator('.subagent-telemetry-elapsed')).toHaveCount(0);
      await expectContained(unknown);
      await parent.locator('.collapsible-chevron').first().click();
      const nested = parent.locator('.tool-call-subagent');
      await expect(nested).toHaveCount(1);
      await nested.scrollIntoViewIfNeeded();
      await expectContained(nested);
      await header(nested).focus();
      await page.keyboard.press('Enter');
      await expect(header(nested)).toHaveAttribute('aria-expanded', 'true');
      await expect(parent.locator('.subagent-header').first()).toHaveAttribute('aria-expanded', 'true');
      const screenshot = info.outputPath(`nested-touch-${width}.png`);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: screenshot });
    }
  });
});

