import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useCaptureHeight } from '../../../transcript/message-item/hooks';

test('height capture preserves the last positive connected measurement before observer cleanup', () => {
  let deliver!: (height: number) => void;
  let disconnected = false;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(callback: ResizeObserverCallback) {
      deliver = (height) => callback([{ contentRect: { height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() { disconnected = true; }
  } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  let captured: number | null = null;
  function Probe() {
    const { messageBodyRef, capturedHeight } = useCaptureHeight('user');
    captured = capturedHeight;
    return h('div', { ref: messageBodyRef }, 'User message');
  }
  try {
    act(() => render(h(Probe, {}), container));
    act(() => deliver(240));
    assert.equal(captured, 240);
    act(() => deliver(180));
    assert.equal(captured, 180, 'normal connected resizes still update');
    act(() => deliver(0));
    assert.equal(captured, 180, 'zero-height deliveries do not erase the capture');
    container.firstElementChild!.remove();
    assert.equal(disconnected, false, 'delivery occurs before effect cleanup');
    act(() => deliver(0));
    assert.equal(captured, 180, 'detached 0x0 delivery preserves the edit minimum');
    act(() => deliver(90));
    assert.equal(captured, 180, 'detached measurements are ignored even if positive');
  } finally {
    act(() => render(null, container));
    container.remove();
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
  assert.equal(disconnected, true);
});
