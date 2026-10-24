import assert from 'node:assert';
import strictAssert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';

/**
 * Test-process-only guard for native reference assertions involving this DOM.
 * Node 24 formats failed strict assertions at depth 1000 with getters enabled,
 * even with a custom message, and ignores inspect.custom. A happy-dom node can
 * lead into the entire window and Preact graph, exhausting memory before a test
 * reports its failure. Keep the comparison unchanged; summarize only failures.
 *
 * Deliberately changes error.actual/expected to bounded diagnostics for DOM
 * failures so Node's test reporter cannot serialize the live graph either.
 * Deep/loose comparisons and assertions without a direct DOM operand remain
 * native. The runner heap cap contains other runaway tests.
 */
export function installDomAssertionDiagnostics(isNode: (value: unknown) => value is Node): void {
  const ids = new WeakMap<Node, number>();
  let nextId = 1;
  const short = (value: string) => value.length > 160 ? `${value.slice(0, 160)}…` : value;
  function summarize(value: unknown): unknown {
    if (isNode(value)) {
      let id = ids.get(value);
      if (id === undefined) { id = nextId++; ids.set(value, id); }
      // Do not read descendants, innerHTML, textContent, or component expandos.
      const elementId = value.nodeType === 1 ? (value as Element).getAttribute('id') : null;
      return `[DOM ${short(value.nodeName)}${elementId ? `#${short(elementId)}` : ''} ref=${id}]`;
    }
    if (typeof value === 'string') return short(value);
    if (typeof value === 'object' && value !== null) return '[non-DOM object]';
    if (typeof value === 'function') return '[function]';
    return value;
  }

  function guard(native: typeof assert.strictEqual, operator: 'strictEqual' | 'notStrictEqual'): typeof assert.strictEqual {
    function bounded(this: unknown, actual: unknown, expected: unknown, message?: string | Error): void {
      // Native validation and all non-DOM behavior stay intact.
      if (arguments.length < 2 || (!isNode(actual) && !isNode(expected))) {
        Reflect.apply(native, this, arguments);
        return;
      }
      const same = Object.is(actual, expected);
      if (operator === 'strictEqual' ? same : !same) return;
      if (message instanceof Error) throw message;
      throw new assert.AssertionError({
        actual: summarize(actual),
        expected: summarize(expected),
        operator,
        message,
        stackStartFn: bounded,
      });
    }
    return bounded as typeof assert.strictEqual;
  }

  const equal = guard(assert.strictEqual, 'strictEqual');
  const notEqual = guard(assert.notStrictEqual, 'notStrictEqual');
  assert.strictEqual = strictAssert.strictEqual = strictAssert.equal = equal;
  assert.notStrictEqual = strictAssert.notStrictEqual = strictAssert.notEqual = notEqual;
  // Cover named ESM imports as well as default/CommonJS imports. installDom()
  // invokes this once, before tests execute, only inside isolated DOM tests.
  syncBuiltinESMExports();
}
