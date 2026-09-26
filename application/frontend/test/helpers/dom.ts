/**
 * DOM environment helper for extension webview tests.
 * Installs happy-dom globals so Preact components can mount.
 */
import { Window } from 'happy-dom';
import { setTimeout as nativeSetTimeout, clearTimeout as nativeClearTimeout } from 'node:timers';

let installed = false;

function installGlobal(key: PropertyKey, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);

  if (!descriptor || descriptor.writable || descriptor.set) {
    try {
      (globalThis as Record<PropertyKey, unknown>)[key] = value;
      return;
    } catch {
      // Fall through to defineProperty for getter-only globals like navigator.
    }
  }

  if (descriptor?.configurable === false) {
    return;
  }

  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

export function installDom(): void {
  if (installed) return;
  installed = true;

  const window = new Window({ url: 'http://localhost' });

  // Install core DOM globals
  const globals = [
    'document', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement',
    'HTMLDivElement', 'HTMLButtonElement', 'HTMLFormElement',
    'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
    'MessageEvent', 'CustomEvent', 'InputEvent',
    'MutationObserver', 'SVGElement', 'navigator',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  ] as const;

  for (const key of globals) {
    if ((window as any)[key] !== undefined) {
      installGlobal(key, (window as any)[key]);
    }
  }

  // Set window itself
  installGlobal('window', window);

  // happy-dom implements requestAnimationFrame via a ref'd setImmediate that it tracks in its
  // AsyncTaskManager. A lingering rAF chain (e.g. the transcript virtualizer scheduling a frame
  // on every render) keeps the Node event loop alive forever with ~0 CPU and no visible handle,
  // so the test process never exits and the file-level test "fails" on the runner's wait. Back
  // rAF with an UNREF'd native timer so pending frames never block process exit. Callbacks still
  // fire while the test is actively running (the event loop is spinning); only post-test lingering
  // frames become non-blocking.
  const unrefRaf = (callback: (time: number) => void): any => {
    const handle = nativeSetTimeout(() => callback((globalThis as any).performance?.now?.() ?? 0), 16) as any;
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
  const unrefCaf = (handle: any): void => { nativeClearTimeout(handle); };
  installGlobal('requestAnimationFrame', unrefRaf);
  installGlobal('cancelAnimationFrame', unrefCaf);
  (window as any).requestAnimationFrame = unrefRaf;
  (window as any).cancelAnimationFrame = unrefCaf;

  // Stub ResizeObserver (happy-dom doesn't provide one)
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // Stub IntersectionObserver
  if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
    (globalThis as any).IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

export function cleanupDom(): void {
  // Nothing to tear down per-test; globals stay for the process.
}
