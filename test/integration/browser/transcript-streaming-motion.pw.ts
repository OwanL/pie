import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ChatMessage, ToolCall } from '../../../application/lib/protocol/index.js';

interface MotionFrame {
  time: number;
  phase: string;
  top: number;
  max: number;
  viewport: number;
  mounted: number;
  tallest: number;
  incoming: { height: number; natural: number } | null;
  footer: { top: number; message: string | undefined } | null;
}
interface CaptureWindow extends Window {
  motionFrames: MotionFrame[];
  motionPhase: string;
  motionTarget: string;
  motionRecording: boolean;
}

// Multiple provider messages, not an ever-growing single synthetic message.
// Real timing is intentional: paused WAAPI tests cannot expose these jumps.
test('streaming prose and provider-message handoffs grow occupied space smoothly', async ({ page, isolatedHost }) => {
  test.setTimeout(45_000);
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'pie-streaming-motion-'));
  const messages: ChatMessage[] = Array.from({ length: 161 }, (_, i) => ({
    id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', status: 'completed',
    createdAt: '2026-10-25T12:00:00Z', markdown: `History ${i}: a short completed exchange.`,
  }));
  const publish = () => isolatedHost.publishState({
    busy: true, transcript: [...messages],
    transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: messages.length, loadedEnd: messages.length, hasUserMessages: true },
  });
  await page.setViewportSize({ width: 390, height: 900 });
  publish();
  await page.goto('/');
  await expect(page.locator('.transcript-virtual')).toBeVisible();
  await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const w = window as CaptureWindow;
    w.motionFrames = [];
    w.motionPhase = 'initial';
    w.motionTarget = '';
    w.motionRecording = true;
    const tick = () => {
      if (!w.motionRecording) return;
      const scroll = document.querySelector<HTMLElement>('.transcript-virtual')!;
      const viewport = scroll.getBoundingClientRect();
      const rows = Array.from(scroll.querySelectorAll<HTMLElement>('[data-index]'));
      const target = w.motionTarget ? scroll.querySelector<HTMLElement>(`[data-message-id="${w.motionTarget}"]`) : null;
      const row = target?.closest<HTMLElement>('[data-index]');
      const footer = Array.from(scroll.querySelectorAll<HTMLElement>('.message-activity-footer:not([aria-hidden="true"])')).at(-1);
      w.motionFrames.push({
        time: performance.now(), phase: w.motionPhase, top: scroll.scrollTop,
        max: scroll.scrollHeight - scroll.clientHeight, viewport: scroll.clientHeight,
        mounted: rows.length, tallest: Math.max(0, ...rows.map(el => el.getBoundingClientRect().height)),
        incoming: target && row ? { height: row.getBoundingClientRect().height, natural: target.getBoundingClientRect().height } : null,
        footer: footer ? { top: footer.getBoundingClientRect().top - viewport.top, message: footer.closest<HTMLElement>('[data-message-id]')?.dataset.messageId } : null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const burst = async (phase: string, target: string) => {
    await page.evaluate(({ phase, target }) => {
      const w = window as CaptureWindow;
      w.motionPhase = phase;
      w.motionTarget = target;
    }, { phase, target });
    publish();
    await page.waitForTimeout(150);
  };
  await burst('busy-placeholder', '');
  const reasoning = 'Tracing the ownership of the current transcript row before choosing the next action.';
  for (let cycle = 0; cycle < 3; cycle++) {
    let current: ChatMessage = {
      id: `provider-${cycle}`, role: 'assistant', status: 'streaming', createdAt: '2026-10-25T12:00:00Z', markdown: '',
      parts: [{ kind: 'reasoning', text: reasoning }],
    };
    messages.push(current);
    await burst(`${cycle}-handoff`, current.id);
    await page.screenshot({ path: path.join(evidence, `cycle-${cycle}-handoff.png`) });
    let text = '';
    for (let n = 0; n < 15; n++) {
      text += `Paragraph ${n}: I am inspecting the transcript scroll ownership and the transition to a separate assistant response. Narrow wrapping makes this a realistic tall live message with detailed explanatory prose.\n\n`;
      current = { ...current, markdown: text, parts: [{ kind: 'reasoning', text: reasoning }, { kind: 'text', text }] };
      messages[messages.length - 1] = current;
      await burst(`${cycle}-prose-${n}`, current.id);
    }
    let tool: ToolCall = { id: `tool-${cycle}`, name: 'read', status: 'drafting', input: {} };
    const updateTool = async (phase: string) => {
      current = { ...current, toolCalls: [tool], parts: [...(current.parts ?? []).filter(part => part.kind !== 'toolCall'), { kind: 'toolCall', toolCall: tool }] };
      messages[messages.length - 1] = current;
      await burst(`${cycle}-${phase}`, current.id);
    };
    await updateTool('draft');
    tool = { ...tool, status: 'running', input: { path: 'application/frontend/transcript/virtual-list.tsx' } };
    await updateTool('running');
    tool = { ...tool, status: 'completed', result: 'Read completed. The transcript row has a measured height and an activity footer.' };
    current = { ...current, status: 'completed' };
    await updateTool('result');
    await page.screenshot({ path: path.join(evidence, `cycle-${cycle}-result.png`) });
  }
  await page.waitForTimeout(500);
  const frames = await page.evaluate(() => {
    const w = window as CaptureWindow;
    w.motionRecording = false;
    return w.motionFrames;
  });
  await writeFile(path.join(evidence, 'frames.json'), JSON.stringify(frames));

  // Verify the intended seam: virtualization is active and the live message
  // crosses the viewport, rather than merely testing a short transcript.
  expect(Math.max(...frames.map(frame => frame.mounted))).toBeLessThan(50);
  expect(Math.max(...frames.map(frame => frame.tallest))).toBeGreaterThan(frames.at(-1)!.viewport);
  for (const cycle of [1, 2]) {
    const handoff = frames.filter(frame => frame.phase === `${cycle}-handoff` && frame.incoming);
    expect(handoff.length).toBeGreaterThan(3);
    expect(handoff[0].incoming!.height, `cycle ${cycle}: new response must not occupy its entire height in one frame`).toBeLessThan(handoff[0].incoming!.natural * 0.75);
  }
  const proseSteps = frames.slice(1).flatMap((frame, i) => {
    const previous = frames[i];
    if (!frame.phase.includes('-prose-') || !frame.footer || !previous.footer || frame.footer.message !== previous.footer.message) return [];
    // Normalize dropped frames without making CI scheduler timing the contract.
    return [(frame.footer.top - previous.footer.top) * Math.min(1, 17 / (frame.time - previous.time))];
  });
  const largestProseStep = Math.max(...proseSteps);
  const composer = await page.locator('.composer-area').boundingBox();
  expect(composer).not.toBeNull();
  expect(composer!.y + composer!.height, 'streaming must not push composer controls out of the viewport').toBeLessThanOrEqual(900);
  const controls = await page.locator('.composer-input-textarea, .composer-actions button').evaluateAll(elements => elements
    .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 2 && rect.height > 2)
    .map(rect => ({ top: rect.top, bottom: rect.bottom })));
  expect(controls.length).toBeGreaterThan(1);
  for (const control of controls) {
    expect(control.top).toBeGreaterThanOrEqual(composer!.y);
    expect(control.bottom).toBeLessThanOrEqual(900);
  }
  await page.screenshot({ path: path.join(evidence, 'settled.png') });
  console.log(JSON.stringify({ evidence, largestProseStep, frames: frames.length, composer }));
  expect(largestProseStep, 'streaming text must not push the footer down a paragraph at once').toBeLessThan(35);
  expect(frames.at(-1)!.max - frames.at(-1)!.top).toBeLessThanOrEqual(2);
  await expect(page.locator('.transcript-virtual [data-height-moving]')).toHaveCount(0);
});


test("restored live rows do not enter; reduced motion releases new responses and text slots immediately", async ({ page, isolatedHost }) => {
  const restored: ChatMessage = {
    id: "restored-live", role: "assistant", status: "streaming", createdAt: "2026-10-25T12:00:00Z",
    markdown: "Restored live text", parts: [{ kind: "text", text: "Restored live text" }],
  };
  const publish = (transcript: ChatMessage[], busy = true) => isolatedHost.publishState({
    transcript, busy, transcriptWindow: {
      ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: transcript.length, loadedEnd: transcript.length,
    },
  });
  publish([restored]);
  await page.goto("/");
  await expect(page.locator(".message-body")).toHaveText("Restored live text");
  await expect(page.locator(".live-message-space[data-height-moving]")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const next: ChatMessage = {
    ...restored, id: "reduced-response", markdown: "",
    parts: [{ kind: "reasoning", text: "Preparing the next response." }],
  };
  publish([{ ...restored, status: "completed" }, next]);
  const row = page.locator("[data-message-id=reduced-response]");
  await expect(row).toBeVisible();
  await expect(page.locator(".transcript-virtual [data-height-moving]")).toHaveCount(0);
  const text = Array.from({ length: 12 }, (_, i) => "Immediate paragraph " + i + ".").join("\n\n");
  publish([{ ...restored, status: "completed" }, { ...next, markdown: text, parts: [...next.parts!, { kind: "text", text }] }]);
  await expect(row.locator(".message-body:not(.reasoning-scroll)")).toContainText("Immediate paragraph 11.");
  await expect(page.locator(".transcript-virtual [data-height-moving]")).toHaveCount(0);
  const heights = await row.locator(".message-body:not(.reasoning-scroll)").evaluate(body => ({
    natural: body.getBoundingClientRect().height, occupied: body.parentElement!.getBoundingClientRect().height,
  }));
  expect(heights.natural).toBeGreaterThan(100);
  expect(Math.abs(heights.natural - heights.occupied)).toBeLessThan(1);
});
