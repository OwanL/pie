import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

// Stub DOMPurify before any component imports (matches webview-render.test.ts)
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ToolCallCard, TOOL_CALL_CLOSE_GRACE_MS, TOOL_CALL_CLOSE_TRANSITION_MS, TOOL_CALL_EXPAND_MS } from '../../../../src/webview/panel/transcript/tool-call-card.tsx';
import { clearCollapsibleCache } from '../../../../src/webview/panel/transcript/use-collapsible-open';
import type { ToolCall } from '../../../../src/shared/protocol';

let container: HTMLElement;

beforeEach(() => {
  clearCollapsibleCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

const noop = () => undefined;
const noopContextMenu = (_e: MouseEvent) => undefined;

function bashTool(status: ToolCall['status'], id: string): ToolCall {
  return {
    id,
    name: 'bash',
    input: { command: 'echo hello' },
    result: status === 'running' ? undefined : 'hello\n',
    status,
    durationMs: status === 'running' ? undefined : 42,
  };
}

function readTool(status: ToolCall['status'], id: string): ToolCall {
  return {
    id,
    name: 'read',
    input: { path: '/repo/README.md' },
    result: status === 'running' ? undefined : 'contents',
    status,
    durationMs: status === 'running' ? undefined : 12,
  };
}

interface FakeTimers {
  advance: (ms: number) => void;
  restore: () => void;
  pendingCount: () => number;
}

/** Install a virtual clock so the grace/close timers fire deterministically
 *  without real waiting. Each callback is flushed inside `act` so Preact
 *  re-renders synchronously. Mirrors the pattern in test/webview/composer/composer-draft.test.ts. */
function useFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  type Pending = { fn: () => void; fireAt: number; id: number };
  let now = 0;
  let pending: Pending[] = [];
  let nextId = 1;

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    pending.push({ fn, fireAt: now + (ms ?? 0), id });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    pending = pending.filter((t) => t.id !== (id as unknown as number));
  }) as typeof globalThis.clearTimeout;

  const advance = (ms: number) => {
    now += ms;
    // Fire due timers in schedule order; a callback may schedule new ones.
    for (;;) {
      const due = pending
        .filter((t) => t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const dueIds = new Set(due.map((t) => t.id));
      pending = pending.filter((t) => !dueIds.has(t.id));
      for (const t of due) {
        act(() => t.fn());
      }
    }
  };

  return {
    advance,
    pendingCount: () => pending.length,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function renderCard(toolCall: ToolCall) {
  act(() => {
    render(
      h(ToolCallCard, {
        toolCall,
        autoExpand: false,
        workingDirectory: '/repo',
        onOpenFile: noop,
        onContextMenu: noopContextMenu,
      }),
      container,
    );
  });
}

const BODY_WRAP = '.tool-call-body-wrap';
const BODY = '.tool-call-body';

test('one stable ToolCallCard owns drafting, ready, and running shell lifecycle', () => {
  const id = 'bash-provisional-lifecycle';
  renderCard({
    id,
    name: 'bash',
    input: '{"command":"npm te',
    argumentsText: '{"command":"npm te',
    status: 'drafting',
  });
  const root = container.querySelector('.tool-call-card');
  assert.ok(root);
  assert.equal(root.getAttribute('data-status'), 'drafting');
  assert.equal(root.getAttribute('data-provisional'), 'true');
  assert.doesNotMatch(root.textContent ?? '', /Drafting/);
  assert.equal(root.querySelector('.status-chip-neutral'), null);
  assert.equal(root.querySelector('.tool-call-draft-cursor'), null);
  assert.ok(!root.querySelector(BODY_WRAP), 'draft input body is not auto-shown');

  renderCard({
    id,
    name: 'bash',
    input: '{"command":"npm test"}',
    argumentsText: '{"command":"npm test"}',
    status: 'ready',
  });
  const readyRoot = container.querySelector('.tool-call-card');
  assert.equal(readyRoot, root, 'stable id keeps the same card DOM node');
  assert.equal(readyRoot?.getAttribute('data-status'), 'ready');
  assert.doesNotMatch(readyRoot?.textContent ?? '', /Ready/);
  assert.equal(readyRoot?.querySelector('.status-chip-neutral'), null);
  assert.ok(!readyRoot?.querySelector(BODY_WRAP), 'ready input body is not auto-shown');
  act(() => {
    (readyRoot?.querySelector('.tool-call-header') as HTMLElement).click();
  });
  assert.match(readyRoot?.querySelector(BODY)?.textContent ?? '', /Input[\s\S]*"command":"npm test"/);

  renderCard({
    id,
    name: 'bash',
    input: { command: 'npm test' },
    result: { content: [{ type: 'text', text: 'running tests' }], details: {} },
    status: 'running',
  });
  const runningRoot = container.querySelector('.tool-call-card');
  assert.equal(runningRoot, root, 'execution continues in the same card DOM node');
  assert.equal(runningRoot?.getAttribute('data-status'), 'running');
  assert.equal(runningRoot?.getAttribute('data-provisional'), null);
  assert.ok(runningRoot?.querySelector(BODY_WRAP), 'shell terminal appears only once running');
});

test('shell auto-shown body lingers after completion, then animates closed via the fallback timer', () => {
  const timers = useFakeTimers();
  try {
    // Running: body auto-shown (open=false), spinner in header.
    renderCard(bashTool('running', 'bash-lifecycle'));
    assert.ok(container.querySelector(BODY_WRAP), 'body shown while running');
    assert.ok(container.querySelector('.tool-call-status-spinner'), 'spinner while running');
    assert.ok(!container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'not closing while running');

    // Complete the command.
    renderCard(bashTool('completed', 'bash-lifecycle'));

    // Immediately after completion: lingering — body still present, NOT closing,
    // completion pulse visible (no status glyph — success is the default state).
    assert.ok(container.querySelector(BODY_WRAP), 'body lingers after completion');
    assert.ok(!container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'not closing during grace');
    assert.ok(!container.querySelector('.tool-call-status-check'), 'no completed check glyph');
    assert.ok(!container.querySelector('.tool-call-status-spinner'), 'no spinner once completed');
    assert.ok(container.querySelector('.tool-call-just-completed'), 'completion pulse class applied');

    // After the grace period: enter the closing state (wrapper gets data-closing).
    timers.advance(TOOL_CALL_CLOSE_GRACE_MS);
    assert.ok(container.querySelector(BODY_WRAP), 'body still mounted while closing');
    assert.ok(container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'wrapper is closing');

    // After the fallback close timer: body unmounts.
    timers.advance(TOOL_CALL_CLOSE_TRANSITION_MS + 60 + 60);
    assert.ok(!container.querySelector(BODY_WRAP), 'body unmounted after close');
    assert.ok(!container.querySelector(BODY), 'inner body unmounted after close');
  } finally {
    timers.restore();
  }
});

test('transitionend on the wrapper unmounts the closing body', () => {
  const timers = useFakeTimers();
  try {
    renderCard(bashTool('running', 'bash-transitionend'));
    renderCard(bashTool('completed', 'bash-transitionend'));

    // Enter closing state.
    timers.advance(TOOL_CALL_CLOSE_GRACE_MS);
    const wrap = container.querySelector(BODY_WRAP) as HTMLElement;
    assert.ok(wrap);
    assert.ok(wrap.getAttribute('data-closing') === 'true');

    // Fire transitionend on the wrapper itself -> unmount.
    act(() => {
      wrap.dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    assert.ok(!container.querySelector(BODY_WRAP), 'body unmounted on transitionend');
  } finally {
    timers.restore();
  }
});

test('manual expand during the grace window cancels the auto-close (sticky)', () => {
  const timers = useFakeTimers();
  try {
    renderCard(bashTool('running', 'bash-manual-open'));
    renderCard(bashTool('completed', 'bash-manual-open'));

    // Lingering: body present, grace timer pending.
    assert.ok(container.querySelector(BODY_WRAP));
    const pendingBefore = timers.pendingCount();
    assert.ok(pendingBefore > 0, 'grace timer pending');

    // User clicks to expand during the grace window.
    const card = container.querySelector('[role="button"]') as HTMLElement;
    act(() => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Body stays (now sticky via open=true), and the auto-close timer is gone.
    assert.ok(container.querySelector(BODY_WRAP), 'body stays after manual expand');
    assert.ok(!container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'not closing after manual expand');

    // Advance well past the grace + close windows: nothing fires, body sticky.
    timers.advance(5000);
    assert.ok(container.querySelector(BODY_WRAP), 'body still mounted — manual open is sticky');
    assert.ok(!container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'still not closing');
  } finally {
    timers.restore();
  }
});

test('non-shell tools get the completion indicator but never auto-open or auto-close', () => {
  const timers = useFakeTimers();
  try {
    // Running read tool: body NOT auto-shown (non-shell), spinner in header.
    renderCard(readTool('running', 'read-nonshell'));
    assert.ok(!container.querySelector(BODY_WRAP), 'non-shell body hidden while running');
    assert.ok(container.querySelector('.tool-call-status-spinner'), 'spinner while running');

    // Complete: completion pulse appears (no status glyph — success is the default
    // state), but no body (open=false) and no grace timer.
    renderCard(readTool('completed', 'read-nonshell'));
    assert.ok(!container.querySelector('.tool-call-status-check'), 'no completed check glyph');
    assert.ok(container.querySelector('.tool-call-just-completed'), 'completion pulse applied');
    assert.ok(!container.querySelector(BODY_WRAP), 'non-shell body never auto-shown');

    // Advancing time must not mount a body (no grace/close for non-shell).
    timers.advance(2000);
    assert.ok(!container.querySelector(BODY_WRAP), 'no auto-close animation for non-shell');
  } finally {
    timers.restore();
  }
});

test('auto-shown shell body gets the expand animation flag, cleared after the animation window', () => {
  const timers = useFakeTimers();
  try {
    renderCard(bashTool('running', 'bash-expand-flag'));
    const wrap = container.querySelector(BODY_WRAP) as HTMLElement;
    assert.ok(wrap, 'body auto-shown while running');
    assert.equal(wrap.getAttribute('data-expand'), 'true', 'expand flag set on auto-show');

    // After the expand animation window (transition + fallback slack) the
    // flag is cleared so the streaming transition-suppress can re-engage.
    timers.advance(TOOL_CALL_EXPAND_MS + 60 + 60);
    const wrapAfter = container.querySelector(BODY_WRAP) as HTMLElement;
    assert.ok(wrapAfter, 'body still mounted');
    assert.ok(!wrapAfter.getAttribute('data-expand'), 'expand flag cleared after animation window');
  } finally {
    timers.restore();
  }
});

test('header command summary hands off into the header as the body begins closing (no post-unmount pop)', () => {
  const timers = useFakeTimers();
  try {
    const SUMMARY = '.transcript-header-summary-command';

    // Running: body auto-shown, summary suppressed (no duplication while visible).
    renderCard(bashTool('running', 'bash-summary-handoff'));
    assert.ok(container.querySelector(BODY_WRAP), 'body shown while running');
    assert.ok(!container.querySelector(SUMMARY), 'summary hidden while body is visible');

    // Complete: lingering — body still present, summary still suppressed.
    renderCard(bashTool('completed', 'bash-summary-handoff'));
    assert.ok(container.querySelector(BODY_WRAP), 'body lingers after completion');
    assert.ok(!container.querySelector(SUMMARY), 'summary still hidden during grace');

    // Grace ends -> body begins closing. The summary is revealed NOW (handoff)
    // rather than after the body unmounts, so the command never pops in.
    timers.advance(TOOL_CALL_CLOSE_GRACE_MS);
    assert.ok(container.querySelector(BODY_WRAP), 'body still mounted while closing');
    assert.ok(container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'wrapper is closing');
    assert.ok(container.querySelector(SUMMARY), 'summary revealed as the body begins closing');

    // After the close transition: body unmounts, summary persists (no pop).
    timers.advance(TOOL_CALL_CLOSE_TRANSITION_MS + 60 + 60);
    assert.ok(!container.querySelector(BODY_WRAP), 'body unmounted after close');
    assert.ok(container.querySelector(SUMMARY), 'summary persists after the body unmounts — no pop');
  } finally {
    timers.restore();
  }
});

test('manual close via the footer animates the body closed then unmounts', () => {
  const timers = useFakeTimers();
  try {
    // Completed read tool, collapsed by default.
    renderCard(readTool('completed', 'read-manual-footer-close'));
    assert.ok(!container.querySelector(BODY_WRAP), 'body hidden when collapsed');

    // Manually open via the header toggle.
    const header = container.querySelector('[role="button"]') as HTMLElement;
    act(() => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.ok(container.querySelector(BODY_WRAP), 'body shown after manual open');
    const footer = container.querySelector('.collapsible-close-footer') as HTMLElement;
    assert.ok(footer, 'close footer present on a manually-opened body');

    // Close via the footer → enter the closing state (data-closing engages).
    act(() => { footer.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.ok(container.querySelector(BODY_WRAP), 'body still mounted while closing');
    assert.ok(container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'wrapper is closing');

    // After the fallback close window: body unmounts.
    timers.advance(TOOL_CALL_CLOSE_TRANSITION_MS + 60 + 60);
    assert.ok(!container.querySelector(BODY_WRAP), 'body unmounted after close');
  } finally {
    timers.restore();
  }
});

test('manual close via the header animates the body closed then unmounts', () => {
  const timers = useFakeTimers();
  try {
    renderCard(readTool('completed', 'read-manual-header-close'));
    const header = container.querySelector('[role="button"]') as HTMLElement;
    // Open, then close via the same header toggle.
    act(() => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.ok(container.querySelector(BODY_WRAP), 'body shown after open');
    act(() => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.ok(container.querySelector(BODY_WRAP), 'body still mounted while closing');
    assert.ok(container.querySelector(`${BODY_WRAP}[data-closing="true"]`), 'wrapper is closing');
    timers.advance(TOOL_CALL_CLOSE_TRANSITION_MS + 60 + 60);
    assert.ok(!container.querySelector(BODY_WRAP), 'body unmounted after close');
  } finally {
    timers.restore();
  }
});

test('a streaming shell body shows no close footer (close cannot animate while running)', () => {
  renderCard(bashTool('running', 'bash-no-footer-while-running'));
  assert.ok(container.querySelector(BODY_WRAP), 'auto-shown body present while running');
  // The footer is gated on `open` — the running body is auto-shown (!open), so
  // no close target is offered (it would be a no-op: data-closing can't engage
  // while showBody is true).
  assert.ok(!container.querySelector('.collapsible-close-footer'), 'no footer on a streaming body');
});
