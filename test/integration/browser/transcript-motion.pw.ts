// Real renderer + disposable publishState host; no backend, SDK or credentials.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ChatMessage, ToolCall, ViewState } from '../../../application/lib/protocol/index.js';

const call = (id: string): ToolCall => ({
  id, name: 'motion_fixture', status: 'completed', input: { subject: id },
  result: Array.from({ length: 12 }, (_, i) => `Visible result line ${i}`).join('\n'),
});
const message = (text = 'Stable prefix', calls: ToolCall[] = [], live = true): ChatMessage => ({
  id: 'motion-turn', role: 'assistant', createdAt: '2026-10-25T12:00:00Z',
  status: live ? 'streaming' : 'completed', markdown: text, toolCalls: calls,
  parts: [{ kind: 'text', text }, ...calls.map(toolCall => ({ kind: 'toolCall' as const, toolCall }))],
});
const state = (turn = message()): Partial<ViewState> => ({
  busy: turn.status === 'streaming', transcript: [turn],
  transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 1, loadedEnd: 1 },
});

// Freeze only the motion under test, at its real browser timeline. No duration
// overrides: production keyframes, layout and reduced-motion gates remain real.
async function holdMotion(page: Page) {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof animate>) {
      const animation = animate.apply(this, args);
      if (this.matches('.tool-call-disclosure-body')) animation.pause();
      return animation;
    };
    document.addEventListener('animationstart', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      for (const animation of target.getAnimations()) {
        if (animation instanceof CSSAnimation && ['pie-stream-text-fade', 'transcript-tool-enter'].includes(animation.animationName)) animation.pause();
      }
    }, true);
  });
}
async function finish(root: Locator) {
  await root.evaluate(async el => {
    const animations = el.getAnimations({ subtree: true });
    animations.forEach(animation => animation.finish());
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
  });
}
async function midpoint(body: Locator) {
  await expect.poll(() => body.evaluate(el => el.getAnimations().length)).toBe(1);
  return body.evaluate(el => {
    const animation = el.getAnimations()[0];
    animation.pause();
    animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    const frames = animation.effect!.getKeyframes();
    return { height: el.getBoundingClientRect().height, from: parseFloat(String(frames[0].height)), to: parseFloat(String(frames.at(-1)!.height)) };
  });
}

test.describe('transcript motion in the isolated renderer', () => {
  test.use({ viewState: state() });

  test('stream snapshots fade only the new suffix, with no reveal backlog', async ({ page, isolatedHost }) => {
    await holdMotion(page);
    await page.goto('/');
    const body = page.locator('.message-body.streaming-text');
    await expect(body).toHaveText('Stable prefix');
    await expect(body.locator('[data-stream-text-fade]')).toHaveCount(0);
    const suffix = ' fresh suffix '.repeat(120);
    isolatedHost.publishState(state(message(`Stable prefix${suffix}`)));
    await expect(body).toHaveText(`Stable prefix${suffix}`.trim());
    const fade = body.locator('[data-stream-text-fade]');
    await expect(fade).toHaveCount(1);
    expect(await fade.textContent()).toBe(suffix);
    await expect.poll(() => fade.evaluate(el => el.getAnimations().some(a => a instanceof CSSAnimation && a.animationName === 'pie-stream-text-fade'))).toBe(true);
    expect(await body.evaluate(el => el.firstElementChild!.firstChild!.textContent)).toBe('Stable prefix');
    await finish(body);
    isolatedHost.publishState(state(message(`Stable prefix${suffix} newest`)));
    await expect(body).toContainText('newest');
    await expect(body.locator('[data-stream-text-fade]')).toHaveText('newest');
  });

  test('selection survives incoming snapshots and releases only the latest text', async ({ page, isolatedHost }) => {
    await page.goto('/');
    const body = page.locator('.message-body');
    await expect(body).toHaveText('Stable prefix');
    await body.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    isolatedHost.publishState(state(message('Stable prefix intermediate')));
    isolatedHost.publishState(state(message('Stable prefix latest snapshot')));
    // Wait for an independent host-driven postcondition, not a timer, while
    // the selected text leaf deliberately defers its DOM replacement.
    isolatedHost.publishState({ busy: false });
    await expect(body).not.toHaveClass(/streaming-text/);
    expect(await page.evaluate(() => getSelection()!.toString())).toBe('Stable prefix');
    await expect(body).toHaveText('Stable prefix');
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await expect(body).toHaveText('Stable prefix latest snapshot');
  });

  test('only appended live tools enter; status, history and reload do not replay', async ({ page, isolatedHost }) => {
    isolatedHost.publishState(state(message('Stable prefix', [call('initial')])));
    await holdMotion(page);
    await page.goto('/');
    const children = page.locator('.tool-call-run-child');
    await expect(children).toHaveCount(1);
    await expect(children.first()).not.toHaveAttribute('data-tool-entered', 'true');
    const calls = [call('initial'), call('appended')];
    isolatedHost.publishState(state(message('Stable prefix', calls)));
    await expect(children).toHaveCount(2);
    await expect(children.last()).toHaveAttribute('data-tool-entered', 'true');
    await expect.poll(() => children.last().evaluate(el => el.getAnimations().some(a => a instanceof CSSAnimation && a.animationName === 'transcript-tool-enter'))).toBe(true);
    await finish(children.last());
    isolatedHost.publishState(state(message('Stable prefix', calls, false)));
    await expect(page.locator('.streaming-text')).toHaveCount(0);
    expect(await children.last().evaluate(el => el.getAnimations().length)).toBe(0);
    isolatedHost.publishState(state(message('Stable prefix', [...calls, call('historical')], false)));
    await expect(children).toHaveCount(3);
    await expect(children.last()).not.toHaveAttribute('data-tool-entered', 'true');
    await page.reload();
    await expect(children).toHaveCount(3);
    await expect(page.locator('[data-tool-entered="true"]')).toHaveCount(0);
  });

  test('ordinary disclosure measures height, keeps the paused header anchored and reverses cleanly', async ({ page, isolatedHost }) => {
    // A single tall row keeps the target mounted while manual scroll ownership
    // pauses follow, avoiding virtualizer edge assumptions.
    isolatedHost.publishState(state(message('Reading context.\n\n'.repeat(35), [call('inspector')], false)));
    await holdMotion(page);
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/');
    const header = page.locator('.tool-call-toggle');
    await header.scrollIntoViewIfNeeded();
    const scroll = page.locator('.transcript-virtual');
    await expect(scroll).not.toHaveClass(/transcript-positioning/);
    await scroll.dispatchEvent('pointerdown', { button: 0 });
    await scroll.evaluate(el => { el.scrollTop -= 80; });
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    const top = (await header.boundingBox())!.y;
    // DOM click avoids Playwright scrolling the anchor during the assertion.
    await header.evaluate(el => (el as HTMLElement).click());
    const body = page.locator('.tool-call-disclosure-body');
    const opening = await midpoint(body);
    expect(opening.from).toBe(0);
    expect(opening.to).toBeGreaterThan(0);
    expect(opening.height).toBeGreaterThan(opening.from);
    expect(opening.height).toBeLessThan(opening.to);
    expect(Math.abs((await header.boundingBox())!.y - top)).toBeLessThanOrEqual(2);
    await finish(body);
    await expect(body).toContainText('Visible result line 11');
    expect(await body.evaluate(el => (el as HTMLElement).style.height)).toBe('');
    const expanded = (await body.boundingBox())!.height;
    await header.evaluate(el => (el as HTMLElement).click());
    const closing = await midpoint(body);
    expect(closing.from).toBeCloseTo(expanded, 0);
    expect(closing.to).toBe(0);
    await expect(body).toHaveAttribute('inert', '');
    await header.evaluate(el => (el as HTMLElement).click());
    const reversed = await midpoint(body);
    expect(reversed.from).toBeCloseTo(closing.height, 0);
    expect(reversed.to).toBeGreaterThan(reversed.from);
    await finish(body);
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();
    expect(Math.abs((await header.boundingBox())!.y - top)).toBeLessThanOrEqual(2);
    await header.evaluate(el => (el as HTMLElement).click());
    await midpoint(body);
    await finish(body);
    await expect(body).toHaveCount(0);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  test('reduced motion renders suffixes and tool disclosure instantly without transcript animations', async ({ page, isolatedHost }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await holdMotion(page);
    await page.goto('/');
    await expect(page.locator('.message-body')).toHaveText('Stable prefix');
    isolatedHost.publishState(state(message('Stable prefix reduced suffix', [call('reduced')])));
    await expect(page.locator('.message-body')).toHaveText('Stable prefix reduced suffix');
    await expect(page.locator('[data-stream-text-fade]')).toHaveCount(0);
    const card = page.locator('.tool-call-card');
    const header = card.locator('.tool-call-toggle');
    await header.click();
    const body = card.locator('.tool-call-disclosure-body');
    await expect(body).toContainText('Visible result line 11');
    expect((await body.boundingBox())!.height).toBeGreaterThan(0);
    expect(await page.locator('.tool-call-run-child').evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
    await header.click();
    await expect(body).toHaveCount(0);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  });
});
