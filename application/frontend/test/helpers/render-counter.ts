/**
 * Render-count harness for measuring component re-renders in tests.
 * Wraps a Preact component and counts how many times it renders.
 */
import { h, type ComponentType, type FunctionComponent } from 'preact';
import { useRef } from 'preact/hooks';

export interface RenderCounter {
  /** Wrapper component that counts renders. Use as <Counter id="foo" /> around content. */
  Counter: FunctionComponent<{ id: string; children?: any }>;
  /** Get the render count for a specific id. */
  getCount: (id: string) => number;
  /** Reset all counts. */
  reset: () => void;
}

export function createRenderCounter(): RenderCounter {
  const counts = new Map<string, number>();

  const Counter: FunctionComponent<{ id: string; children?: any }> = ({ id, children }) => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    return h('div', { 'data-render-counter': id }, children);
  };

  return {
    Counter,
    getCount: (id: string) => counts.get(id) ?? 0,
    reset: () => counts.clear(),
  };
}

/**
 * Creates a counting wrapper around a component.
 * Each render of the wrapped component increments the counter for the given key.
 */
export function withRenderCount<P extends object>(
  Component: ComponentType<P>,
  counts: Map<string, number>,
  keyFn: (props: P) => string,
): ComponentType<P> {
  const Wrapped: FunctionComponent<P> = (props) => {
    const key = keyFn(props);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return h(Component, props);
  };
  Wrapped.displayName = `RenderCounted(${Component.displayName || Component.name || 'Component'})`;
  return Wrapped;
}
