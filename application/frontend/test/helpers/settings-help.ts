import assert from 'node:assert/strict';
import { act } from 'preact/test-utils';

/** Advance only SettingsHelp's window-owned show delay; leave global timers,
 * RAF, and provider polling alone. The real Tooltip still renders its host. */
export function focusSettingsHelp(trigger: HTMLButtonElement): void {
  const setDescriptor = Object.getOwnPropertyDescriptor(window, 'setTimeout');
  const clearDescriptor = Object.getOwnPropertyDescriptor(window, 'clearTimeout');
  const originalSet = window.setTimeout;
  const originalClear = window.clearTimeout;
  const pending = new Map<number, { callback: () => void; deadline: number }>();
  let nextId = -1;
  let now = 0;
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of pending) {
      if (timer.deadline > now) continue;
      pending.delete(id);
      timer.callback();
    }
  };
  const restore = (key: 'setTimeout' | 'clearTimeout', descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(window, key, descriptor);
    else Reflect.deleteProperty(window, key);
  };
  try {
    Object.defineProperty(window, 'setTimeout', { configurable: true, writable: true, value:
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay !== 150 || typeof callback !== 'function') {
          return Reflect.apply(originalSet, window, [callback, delay, ...args]);
        }
        const id = nextId--;
        pending.set(id, { callback: () => callback(...args), deadline: now + delay });
        return id;
      }) as typeof window.setTimeout,
    });
    Object.defineProperty(window, 'clearTimeout', { configurable: true, writable: true, value:
      ((id?: number) => {
        if (id !== undefined && id < 0) pending.delete(id);
        else originalClear.call(window, id);
      }) as typeof window.clearTimeout,
    });
    act(() => trigger.focus());
    assert.equal(pending.size, 1, 'focus schedules the SettingsHelp show delay');
    act(() => advance(149));
    assert.equal(trigger.getAttribute('aria-describedby'), null, 'help is not exposed before 150ms');
    act(() => advance(1));
    const id = trigger.getAttribute('aria-describedby');
    assert.ok(id, 'help is described at the 150ms deadline');
    const host = document.getElementById(id);
    assert.ok(host, 'real Tooltip host exists');
    assert.equal(host.style.display, 'block', 'help host is visible at the deadline');
  } finally {
    pending.clear();
    restore('setTimeout', setDescriptor);
    restore('clearTimeout', clearDescriptor);
  }
}
