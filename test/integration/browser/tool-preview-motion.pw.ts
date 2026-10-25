// Stateful synthetic host, real renderer. Measure occupied space and sibling
// positions separately: a run envelope alone cannot smooth an internal row.
import type { Page } from '@playwright/test';
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ToolCall, ViewState } from '../../../application/lib/protocol/index.js';

const sibling: ToolCall = { id: 'settled', name: 'read', status: 'completed', input: { path: 'settled.txt' }, result: 'Already reviewed' };
function call(name: string, lines: number, status?: ToolCall['status']): ToolCall {
  const text = Array.from({ length: lines }, (_, i) => `preview row ${i + 1}`).join('\n');
  const input = name === 'edit' ? { path: 'fixture.ts', edits: [{ oldText: 'old', newText: text }] }
    : name === 'write' ? { path: 'fixture.ts', content: text } : { command: 'printf synthetic' };
  return { id: 'growing', name, status: status ?? (name === 'bash' ? 'running' : 'drafting'),
    input: name === 'bash' ? input : {}, argumentsText: JSON.stringify(input), ...(name === 'bash' ? { result: text } : {}) };
}
function state(tool: ToolCall | null, active = true, tall = false, additions: ToolCall[] = []): Partial<ViewState> {
  const tools = [...(tool ? [tool, sibling] : [sibling]), ...additions];
  const text = tall ? 'Existing conversation kept above the live preview.\n\n'.repeat(60) : 'Reviewing the implementation.';
  return { busy: active, liveTurnPhase: null, prefs: { ...EMPTY_VIEW_STATE.prefs, activityTailLines: 3 },
    transcript: [{ id: 'user', role: 'user', createdAt: '2026-10-26T11:59:59Z', status: 'completed', markdown: 'Review the live tool preview.' },
      { id: 'assistant', role: 'assistant', createdAt: '2026-10-26T12:00:00Z',
      status: active ? 'streaming' : 'completed', markdown: text,
      toolCalls: tools, parts: [{ kind: 'text', text }, ...tools.map(toolCall => ({ kind: 'toolCall' as const, toolCall }))] }],
    transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 2, loadedEnd: 2, hasUserMessages: true } };
}
async function open(page: Page, width = 550) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const playback = window as Window & { holdTranscriptMotion: boolean };
    playback.holdTranscriptMotion = true;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof animate>) {
      const animation = animate.apply(this, args);
      if (playback.holdTranscriptMotion && this.matches('.tool-call-preview-space, .tool-call-list, .message-activity-footer, .turn-activity-strip')) {
        animation.pause(); animation.currentTime = 0;
      }
      return animation;
    };
  });
  await page.goto('/');
  await expect(page.locator('.tool-call-card')).toHaveCount(2);
  await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
  await page.evaluate(() => document.fonts.ready);
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.transcript-virtual')!;
    const footer = document.querySelector<HTMLElement>('.message-activity-footer');
    const sibling = document.querySelectorAll('.tool-call-card')[1]!;
    const preview = document.querySelector('.tool-call-preview-space')!;
    return { sibling: sibling.getBoundingClientRect().top + scroll.scrollTop,
      footer: footer ? footer.getBoundingClientRect().top + scroll.scrollTop : null,
      height: preview.getBoundingClientRect().height, scroll: scroll.scrollTop };
  });
}
async function finish(page: Page) {
  // A preview changing during a run entrance can retarget the run's envelope.
  // Drain both owners after each layout notification rather than using sleeps.
  for (let i = 0; i < 5; i++) {
    const count = await page.locator('.tool-call-preview-space, .tool-call-list, .message-activity-footer, .turn-activity-strip').evaluateAll(async elements => {
      const animations = elements.flatMap(el => el.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)));
      animations.forEach(a => a.finish());
      await Promise.all(animations.map(a => a.finished.catch(() => undefined)));
      return animations.length;
    });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (count === 0) break;
  }
}

for (const name of ['write', 'edit', 'bash']) {
  test(`${name}: live rows, reversal and removal move siblings without replaying history`, async ({ page, isolatedHost }) => {
    isolatedHost.publishState(state(call(name, 1)));
    await open(page, name === 'bash' ? 900 : 550);
    const space = page.locator('.tool-call-preview-space').first();
    expect(await space.evaluate(el => el.getAnimations().length)).toBe(0);
    const before = await geometry(page);
    isolatedHost.publishState(state(call(name, 3)));
    await expect(page.locator('.tool-call-live-preview pre')).toHaveText('preview row 1\npreview row 2\npreview row 3');
    await expect(space).toHaveAttribute('data-preview-moving', 'true');
    const start = await geometry(page);
    expect(Math.abs(start.sibling - before.sibling)).toBeLessThanOrEqual(1);
    expect(Math.abs(start.footer! - before.footer!)).toBeLessThanOrEqual(1);
    expect(await page.locator('.tool-call-list').evaluate(el => el.getAnimations().length)).toBe(0);
    const target = await space.evaluate(el => {
      const animation = el.getAnimations()[0]!;
      const frames = animation.effect!.getKeyframes();
      animation.currentTime = 80;
      return Number.parseFloat(String(frames[frames.length - 1]!.height));
    });
    const mid = await geometry(page);
    expect(mid.height).toBeGreaterThan(before.height + 1);
    expect(mid.height).toBeLessThan(target - 1);
    expect(mid.sibling).toBeGreaterThan(before.sibling + 1);
    expect(mid.footer!).toBeGreaterThan(before.footer! + 1);
    isolatedHost.publishState(state(call(name, 2)));
    await expect(page.locator('.tool-call-live-preview pre')).toHaveText('preview row 1\npreview row 2');
    expect(Math.abs((await geometry(page)).sibling - mid.sibling), 'reverse from rendered height').toBeLessThanOrEqual(1);
    await finish(page);
    const settled = await geometry(page);
    expect(settled.height).toBeGreaterThan(before.height);
    isolatedHost.publishState(state(call(name, 2, 'completed')));
    await expect(page.locator('.tool-call-live-preview')).toHaveCount(0);
    await expect(space).toHaveAttribute('data-preview-moving', 'true');
    expect(Math.abs((await geometry(page)).sibling - settled.sibling), 'completion must not snap the next tool').toBeLessThanOrEqual(1);
    await finish(page);
    expect((await geometry(page)).height).toBe(0);
    await expect(space).not.toHaveAttribute('data-preview-moving');
    expect(await space.evaluate(el => (el as HTMLElement).style.height)).toBe('');
    isolatedHost.publishState(state(call(name, 3)));
    await expect(page.locator('.tool-call-live-preview pre')).toContainText('preview row 3');
    await page.reload();
    await expect(page.locator('.tool-call-live-preview pre')).toContainText('preview row 3');
    await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
    expect(await space.evaluate(el => el.getAnimations().length)).toBe(0);
    expect(await page.locator('.message-activity-footer, .turn-activity-strip').evaluateAll(elements => elements.flatMap(el => el.getAnimations()).length)).toBe(0);
  });
}

test('footer labels are immediately current; appearance, removal and reversal animate space without idle gaps', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state(call('bash', 1)));
  await open(page);
  const footer = page.locator('.message-activity-footer');
  const strip = page.locator('.turn-activity-strip');
  expect(await footer.evaluate(el => el.getAnimations().length)).toBe(0);
  expect(await strip.evaluate(el => el.getAnimations().length)).toBe(0);
  isolatedHost.publishState(state({ ...call('bash', 1), name: 'custom_tool' }));
  await expect(strip).toContainText('running custom_tool');
  await expect(strip).toHaveAttribute('aria-label', /running custom_tool/);
  expect(await strip.evaluate(el => el.getAnimations().length)).toBe(1);
  await finish(page);
  const originalHeight = await footer.evaluate(el => el.getBoundingClientRect().height);
  isolatedHost.publishState(state(call('bash', 1, 'completed'), false));
  await expect(footer).toHaveAttribute('aria-hidden', 'true');
  await expect(footer.getByRole('status')).toHaveCount(0);
  await expect(footer).toHaveAttribute('data-space-moving', '');
  expect(Math.abs(await footer.evaluate(el => el.getBoundingClientRect().height) - originalHeight)).toBeLessThanOrEqual(1);
  await footer.evaluate(el => el.getAnimations().forEach(a => { a.currentTime = 80; }));
  const closingHeight = await footer.evaluate(el => el.getBoundingClientRect().height);
  expect(closingHeight).toBeGreaterThan(0);
  expect(closingHeight).toBeLessThan(originalHeight);
  isolatedHost.publishState(state(call('bash', 1)));
  await expect(strip).toContainText('running bash');
  await expect(footer).not.toHaveAttribute('aria-hidden');
  expect(Math.abs(await footer.evaluate(el => el.getBoundingClientRect().height) - closingHeight)).toBeLessThanOrEqual(1);
  await finish(page);
  isolatedHost.publishState(state(call('bash', 1, 'completed'), false));
  await expect(footer).toHaveAttribute('data-space-moving', '');
  await finish(page);
  await expect(footer).toHaveCount(0);
  isolatedHost.publishState(state(call('bash', 1)));
  await expect(strip).toContainText('running bash');
  await expect(footer).toHaveAttribute('data-space-moving', '');
  expect(await footer.evaluate(el => el.getBoundingClientRect().height)).toBe(0);
  await finish(page);
  expect(await footer.evaluate(el => el.getBoundingClientRect().height)).toBe(originalHeight);
  isolatedHost.publishState(state(call('bash', 1, 'completed'), false));
  await expect(footer).toHaveAttribute('data-space-moving', '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(footer).toHaveCount(0);
  isolatedHost.publishState(state(call('bash', 1)));
  await expect(strip).toContainText('running bash');
  expect(await footer.evaluate(el => el.getAnimations().length)).toBe(0);
});

test('preview growth during a run entrance settles and reduced motion releases every occupied-space animation', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state(call('bash', 1), true, true));
  await open(page, 390);
  // Detach follow without selecting or modifying the real tool controls.
  const transcript = page.locator('.transcript-virtual');
  await transcript.hover();
  const bottom = await transcript.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(bottom);
  const scroll = await transcript.evaluate(el => el.scrollTop);
  const selected = await page.locator('.message-body p').first().evaluate(el => {
    const range = document.createRange();
    range.setStart(el.firstChild!, 0); range.setEnd(el.firstChild!, 20);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  });
  const appended = (lines: number) => [{ ...call('write', lines), id: 'new-preview' }, { ...sibling, id: 'following-appended' }];
  isolatedHost.publishState(state(call('bash', 1), true, true, appended(1)));
  await expect(page.locator('.tool-call-card')).toHaveCount(4);
  await expect.poll(() => page.locator('.tool-call-list').evaluate(el => el.getAnimations().length)).toBe(1);
  await page.locator('.tool-call-list').evaluate(el => el.getAnimations().forEach(a => { a.currentTime = 80; }));
  isolatedHost.publishState(state(call('bash', 1), true, true, appended(3)));
  const growing = page.locator('.tool-call-preview-space').nth(2);
  await expect(page.locator('.tool-call-live-preview pre').last()).toContainText('preview row 3');
  await expect(growing).toHaveAttribute('data-preview-moving', 'true');
  await page.locator('.tool-call-preview-space, .tool-call-list, .turn-activity-strip').evaluateAll(elements => {
    // Retargeted run animations must also run normally, not be frozen by the
    // deterministic geometry clock used in the first half of this scenario.
    (window as Window & { holdTranscriptMotion: boolean }).holdTranscriptMotion = false;
    elements.forEach(el => el.getAnimations().forEach(a => a.play()));
  });
  await expect(growing).not.toHaveAttribute('data-preview-moving');
  await expect.poll(() => page.locator('.tool-call-list').evaluate(el => el.getAnimations().length)).toBe(0);
  expect(await page.locator('.tool-call-list').evaluate(el => Math.abs(el.getBoundingClientRect().height - el.firstElementChild!.getBoundingClientRect().height))).toBeLessThanOrEqual(1);
  await page.evaluate(() => { (window as Window & { holdTranscriptMotion: boolean }).holdTranscriptMotion = true; });
  isolatedHost.publishState(state(call('bash', 1), true, true, appended(1)));
  await expect(growing).toHaveAttribute('data-preview-moving', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-preview-moving], [data-space-moving]')).toHaveCount(0);
  expect(await page.locator('.tool-call-list').evaluate(el => el.getAnimations().length)).toBe(0);
  expect(await page.locator('.tool-call-preview-space').first().evaluate(el => (el as HTMLElement).style.height)).toBe('');
  expect(Math.abs(await transcript.evaluate(el => el.scrollTop) - scroll), 'paused reader stays anchored').toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
  isolatedHost.publishState(state(call('bash', 1), true, true));
  await expect(page.locator('.tool-call-live-preview pre')).toHaveCount(1);
  await expect(page.locator('.tool-call-live-preview pre')).toHaveText('preview row 1');
  expect(await page.locator('.tool-call-preview-space').first().evaluate(el => el.getAnimations().length)).toBe(0);
});
