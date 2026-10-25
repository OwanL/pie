import test from 'node:test';
import assert from 'node:assert/strict';
import { animateHeightChange, cancelHeightMotion } from '../../lib/components/height-motion';

function fixture() {
  let height = 40;
  let reduced = false;
  const changes = new Set<() => void>();
  const attrs = new Set<string>();
  const styles = new Map<string, string>([['overflow', 'visible']]);
  const runs: { frames: Keyframe[]; resolve: () => void; cancelled: boolean }[] = [];
  const element = {
    ownerDocument: { defaultView: { matchMedia: () => ({
      get matches() { return reduced; },
      addEventListener: (_: string, fn: () => void) => changes.add(fn),
      removeEventListener: (_: string, fn: () => void) => changes.delete(fn),
    }) } },
    style: {
      getPropertyValue: (key: string) => styles.get(key) ?? '',
      getPropertyPriority: () => '',
      setProperty: (key: string, value: string) => styles.set(key, value),
      removeProperty: (key: string) => styles.delete(key),
    },
    getBoundingClientRect: () => ({ height }),
    setAttribute: (key: string) => attrs.add(key),
    removeAttribute: (key: string) => attrs.delete(key),
    dispatchEvent: () => true,
    animate: (frames: Keyframe[]) => {
      let resolve!: () => void;
      const finished = new Promise<void>((done) => { resolve = done; });
      const run = { frames, resolve, cancelled: false };
      runs.push(run);
      return { finished, cancel: () => { run.cancelled = true; } };
    },
  } as unknown as HTMLElement;
  return { element, runs, attrs, styles, changes,
    height: (value: number) => { height = value; },
    reduce: () => { reduced = true; for (const fn of changes) fn(); },
  };
}

test('height change commits synchronously, skips equal boxes, and restores styles', async () => {
  const f = fixture();
  animateHeightChange(f.element, () => {});
  assert.equal(f.runs.length, 0);
  animateHeightChange(f.element, () => f.height(90));
  assert.deepEqual(f.runs[0].frames, [{ height: '40px' }, { height: '90px' }]);
  assert.ok(f.attrs.has('data-height-moving'));
  f.runs[0].resolve();
  await Promise.resolve();
  assert.equal(f.styles.get('overflow'), 'visible');
  assert.equal(f.attrs.size, 0);
  assert.equal(f.changes.size, 0);
});

test('retarget uses the rendered box over from; stale completion cannot finish the new owner', async () => {
  const f = fixture();
  animateHeightChange(f.element, () => f.height(90));
  f.height(65);
  animateHeightChange(f.element, () => f.height(20), { from: 0 });
  assert.equal(f.runs[1].frames[0].height, '65px');
  f.runs[0].resolve();
  await Promise.resolve();
  assert.ok(f.attrs.has('data-height-moving'));
  f.reduce();
  assert.equal(f.attrs.size, 0);
  assert.equal(f.changes.size, 0);
  cancelHeightMotion(f.element);
});
