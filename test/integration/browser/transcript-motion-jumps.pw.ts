// Real isolated renderer: verify sibling layout, not just the incoming card's fade.
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ChatMessage, ChatMessagePart, ToolCall, ViewState } from '../../../application/lib/protocol/index.js';
import type { SubagentSingleResult } from '../../../harness/agent-processes/workers/subagent-result.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const ask: ToolCall = { id: 'ask', name: 'ask_user', status: 'running', input: {
  question: 'Should I investigate the transcript jump?', options: ['Investigate', 'Wait'], allowCustom: true,
} };
const child: SubagentSingleResult = { agent: 'scout', task: 'Trace transcript layout ownership',
  model: 'fixture/Model', exitCode: -1, messages: [], activityPhase: 'waiting_provider',
  startedAt: NOW, activitySince: NOW, activityDetail: 'Waiting for isolated fixture provider',
};
const subagent: ToolCall = { id: 'new-subagent', name: 'subagent', status: 'running',
  input: { agent: child.agent, task: child.task }, result: { mode: 'single', results: [child] } };

function state({ tall = false, newRun = false, additions = [] }: {
  tall?: boolean;
  newRun?: boolean;
  additions?: ToolCall[];
} = {}): Partial<ViewState> {
  const text = tall ? 'Reading the existing transcript before delegation.\n\n'.repeat(45) : 'I will investigate.';
  const parts: ChatMessagePart[] = [{ kind: 'text', text }, { kind: 'toolCall', toolCall: ask }];
  if (newRun) parts.push({ kind: 'text', text: 'Now delegating the independent investigation.' });
  parts.push(...additions.map(toolCall => ({ kind: 'toolCall' as const, toolCall })));
  const transcript: ChatMessage[] = [
    { id: 'user', role: 'user', createdAt: new Date(NOW).toISOString(), status: 'completed', markdown: 'Investigate the jump when a new subagent appears.' },
    { id: 'assistant', role: 'assistant', createdAt: new Date(NOW).toISOString(), status: 'streaming', markdown: text,
      parts, toolCalls: [ask, ...additions] },
  ];
  return { busy: true, transcript, transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow,
    totalCount: 2, loadedEnd: 2, hasUserMessages: true } };
}

async function holdEntrances(page: Page) {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof animate>) {
      const animation = animate.apply(this, args);
      if (this.matches('.tool-call-list, .tool-call-run-child')) { animation.pause(); animation.currentTime = 0; }
      return animation;
    };
    document.addEventListener('animationstart', event => {
      if (!(event.target instanceof Element)) return;
      for (const animation of event.target.getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName === 'transcript-tool-enter') {
          animation.pause(); animation.currentTime = 0;
        }
      }
    }, true);
  });
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.transcript-virtual')!;
    const footer = document.querySelector<HTMLElement>('.message-activity-footer')!;
    const incoming = document.querySelector<HTMLElement>('[data-tool-entered="true"]');
    const bounds = footer.getBoundingClientRect();
    const list = incoming?.parentElement;
    return { footerTop: bounds.top, footerContentTop: bounds.top + scroll.scrollTop,
      footerHeight: bounds.height, footerText: footer.textContent, scrollTop: scroll.scrollTop,
      incomingHeight: incoming?.getBoundingClientRect().height ?? 0,
      incomingOffsetHeight: incoming?.offsetHeight ?? 0,
      incomingOpacity: incoming ? getComputedStyle(incoming).opacity : null,
      listMarginTop: list ? getComputedStyle(list).marginTop : null,
      listGap: list ? getComputedStyle(list).rowGap : null,
      animations: incoming?.getAnimations().map(a => ({ time: a.currentTime,
        duration: a.effect?.getTiming().duration, keyframes: a.effect?.getKeyframes() })) ?? [],
    };
  });
}

async function finishRun(page: Page) {
  const run = page.locator('.tool-call-list').last();
  await run.evaluate(async el => {
    const animations = el.getAnimations({ subtree: true });
    animations.forEach(a => a.finish());
    await Promise.all(animations.map(a => a.finished.catch(() => undefined)));
  });
  await expect.poll(() => run.evaluate(el => el.getAnimations().length)).toBe(0);
  expect(await run.evaluate(el => (el as HTMLElement).style.overflow)).toBe('');
}

for (const lifecycle of ['late first result', 'rapid retarget', 'reduced motion'] as const) {
  test(`run lifecycle: ${lifecycle}`, async ({ page, isolatedHost }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.clock.setFixedTime(NOW);
    await holdEntrances(page);
    isolatedHost.publishState(state());
    await page.goto('/');
    await expect(page.locator('.message-activity-footer')).toContainText('running ask_user');
    await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
    await page.evaluate(() => document.fonts.ready);
    const draft: ToolCall = { ...subagent, status: 'drafting', input: {}, result: undefined,
      argumentsText: JSON.stringify(subagent.input) };
    isolatedHost.publishState(state({ additions: [lifecycle === 'late first result' ? draft : subagent] }));
    const run = page.locator('.tool-call-list').last();
    await expect(page.locator('.tool-call-run-child')).toHaveCount(2);
    await expect.poll(() => run.evaluate(el => el.getAnimations().length)).toBe(1);

    if (lifecycle === 'late first result') {
      await finishRun(page);
      const before = await measure(page);
      isolatedHost.publishState(state({ additions: [subagent] }));
      await expect(page.locator('.message-activity-footer')).toContainText('running 2 tools');
      const first = await measure(page);
      expect.soft(Math.abs(first.footerContentTop - before.footerContentTop), 'result starts at settled drafting height').toBeLessThanOrEqual(2);
      await expect.poll(() => run.evaluate(el => el.getAnimations().length), 'first result animates without an append').toBe(1);
      await run.evaluate(el => el.getAnimations().forEach(a => { a.currentTime = Number(a.effect!.getTiming().duration) / 2; }));
      const mid = await measure(page);
      await finishRun(page);
      const final = await measure(page);
      expect(mid.footerContentTop).toBeGreaterThan(before.footerContentTop + 2);
      expect(mid.footerContentTop).toBeLessThan(final.footerContentTop - 2);
    } else if (lifecycle === 'rapid retarget') {
      await run.evaluate(el => el.getAnimations().forEach(a => { a.currentTime = Number(a.effect!.getTiming().duration) / 2; }));
      const before = await measure(page);
      const second = { ...subagent, id: 'second-subagent' };
      isolatedHost.publishState(state({ additions: [subagent, second] }));
      await expect(page.locator('.tool-call-run-child')).toHaveCount(3);
      expect(Math.abs((await measure(page)).footerContentTop - before.footerContentTop), 'append retarget starts at rendered space').toBeLessThanOrEqual(2);
      await run.evaluate(el => el.getAnimations().forEach(a => { a.currentTime = Number(a.effect!.getTiming().duration) / 2; }));
      const height = await run.evaluate(el => el.getBoundingClientRect().height);
      await page.setViewportSize({ width: 300, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(Math.abs(await run.evaluate(el => el.getBoundingClientRect().height) - height), 'resize must not release retained height').toBeLessThanOrEqual(2);
      await run.evaluate(el => el.getAnimations({ subtree: true }).forEach(a => a.play()));
      await expect.poll(() => run.evaluate(el => el.getAnimations().length)).toBe(0);
      expect(await run.evaluate(el => (el as HTMLElement).style.overflow)).toBe('');
      const settled = await measure(page);
      isolatedHost.publishState(state({ additions: [subagent, { ...second,
        result: { mode: 'single', results: [{ ...child, activityPhase: 'streaming', activityDetail: 'Streaming isolated fixture provider output' }] } }] }));
      await expect(page.locator('.tool-call-list')).toContainText('Streaming isolated fixture provider output');
      await expect(page.locator('.message-activity-footer')).toContainText('running 3 tools');
      expect(await run.evaluate(el => el.getAnimations().length)).toBe(0);
      expect(Math.abs((await measure(page)).footerContentTop - settled.footerContentTop)).toBeLessThanOrEqual(2);
    } else {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect.poll(() => run.evaluate(el => el.getAnimations().length)).toBe(0);
      expect(await run.evaluate(el => (el as HTMLElement).style.overflow)).toBe('');
      expect(await run.evaluate(el => Math.abs(el.getBoundingClientRect().height - el.firstElementChild!.getBoundingClientRect().height))).toBeLessThanOrEqual(2);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.reload();
      await expect(page.locator('.tool-call-run-child')).toHaveCount(2);
      await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
      expect(await run.evaluate(el => el.getAnimations().length)).toBe(0);
      expect(await run.evaluate(el => (el as HTMLElement).style.overflow)).toBe('');
    }
  });
}

for (const scenario of [
  { name: 'short consecutive run at 390', width: 390, tall: false, newRun: false },
  { name: 'tall consecutive run at 900', width: 900, tall: true, newRun: false },
  { name: 'first tool in a new run at 390', width: 390, tall: false, newRun: true },
]) {
  test(scenario.name, async ({ page, isolatedHost }, info) => {
    const evidence = await mkdtemp(path.join(os.tmpdir(), 'pie-motion-jumps-'));
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.clock.setFixedTime(NOW);
    await holdEntrances(page);
    isolatedHost.publishState(state(scenario));
    await page.goto('/');
    const footer = page.locator('.message-activity-footer');
    await expect(footer).toContainText('running ask_user');
    await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
    await page.evaluate(() => document.fonts.ready);
    const before = await measure(page);
    await page.screenshot({ path: path.join(evidence, 'before.png') });
    isolatedHost.publishState(state({ ...scenario, additions: [subagent] }));
    await expect(page.locator('.tool-call-run-child')).toHaveCount(2);
    await expect(footer).toContainText('running 2 tools');
    const incoming = page.locator('[data-tool-entered="true"]');
    await expect(incoming).toHaveCount(1);
    const run = page.locator('.tool-call-list').last();
    await expect.poll(() => run.evaluate(el => el.getAnimations().length)).toBe(1);
    const first = await measure(page);
    await page.screenshot({ path: path.join(evidence, 'first.png') });
    await run.evaluate(el => el.getAnimations({ subtree: true }).forEach(a => {
      a.pause(); a.currentTime = Number(a.effect!.getTiming().duration) / 2;
    }));
    const mid = await measure(page);
    await page.screenshot({ path: path.join(evidence, 'mid.png') });
    await run.evaluate(async el => {
      const animations = el.getAnimations({ subtree: true });
      animations.forEach(a => a.finish());
      await Promise.all(animations.map(a => a.finished.catch(() => undefined)));
    });
    await expect.poll(() => run.evaluate(el => el.getAnimations().length)).toBe(0);
    expect(await run.evaluate(el => (el as HTMLElement).style.overflow)).toBe('');
    const final = await measure(page);
    await page.screenshot({ path: path.join(evidence, 'final.png') });
    const metrics = { scenario, before, first, mid, final,
      initialJump: first.footerContentTop - before.footerContentTop,
      finalDisplacement: final.footerContentTop - before.footerContentTop,
      footerHeightChange: first.footerHeight - before.footerHeight };
    await writeFile(path.join(evidence, 'metrics.json'), JSON.stringify(metrics, null, 2));
    await info.attach('layout-metrics', { body: JSON.stringify({ evidence, ...metrics }, null, 2), contentType: 'application/json' });
    console.log('Motion jump evidence:', evidence);
    // Check the existing sibling, not opacity/transform of the inserted card.
    // Scroll-normalized coordinates separate follow motion from layout growth.
    expect.soft(Math.abs(first.footerContentTop - before.footerContentTop), 'entrance at t=0 must not instantly displace the existing footer').toBeLessThanOrEqual(2);
    const displacement = final.footerContentTop - before.footerContentTop;
    expect.soft(mid.footerContentTop - before.footerContentTop, 'midpoint must progress beyond its starting space').toBeGreaterThan(2);
    expect.soft(mid.footerContentTop - before.footerContentTop, 'midpoint must not already occupy all final sibling space').toBeLessThan(displacement - 2);
    expect.soft(final.footerHeight).toBe(before.footerHeight);
  });
}
