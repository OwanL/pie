import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesUrl = pathToFileURL(path.resolve(__dirname, '../rules.ts')).href;

type RuleResult = { text: string; changed: boolean } | null;
type RuleCtx = { toolName: string; input: Record<string, unknown>; profile: string };
type Rule = { name: string; run: (text: string, ctx: RuleCtx) => RuleResult };
type RulesModule = { LOSSLESS_RULES: Rule[] };

const ctx: RuleCtx = { toolName: "bash", input: { command: "ls" }, profile: "default" };

function rule(name: string, mod: RulesModule): Rule {
  const r = mod.LOSSLESS_RULES.find((x) => x.name === name);
  if (!r) throw new Error(`rule ${name} not found`);
  return r;
}

describe('lossless rules', () => {
  let mod: RulesModule;
  test.before(async () => {
    mod = (await import(rulesUrl)) as RulesModule;
  });

  describe('ansi-strip', () => {
    test('strips CSI color sequences', () => {
      const out = rule("ansi-strip", mod).run("\u001B[31mred\u001B[0m text", ctx);
      assert.equal(out?.text, "red text");
      assert.equal(out?.changed, true);
    });

    test('strips OSC (title) sequences ending in BEL', () => {
      const out = rule("ansi-strip", mod).run("a\u001B]0;title\u0007b", ctx);
      assert.equal(out?.text, "ab");
    });

    test('no-op when no escapes present', () => {
      const out = rule("ansi-strip", mod).run("plain output", ctx);
      assert.equal(out, null);
    });

    test('passes through non-ASCII / CJK unchanged', () => {
      const out = rule("ansi-strip", mod).run("\u001B[32m日本語\u001B[0m", ctx);
      assert.equal(out?.text, "日本語");
    });
  });

  describe('trim-trailing-whitespace', () => {
    test('removes trailing spaces and tabs per line', () => {
      const out = rule("trim-trailing-whitespace", mod).run("a   \nb\t\t\nc", ctx);
      assert.equal(out?.text, "a\nb\nc");
    });

    test('normalizes CRLF to LF (CR is trailing ws)', () => {
      const out = rule("trim-trailing-whitespace", mod).run("a\r\nb\r\n", ctx);
      assert.equal(out?.text, "a\nb\n");
    });

    test('preserves leading indentation', () => {
      const out = rule("trim-trailing-whitespace", mod).run("  a  \n\t b\t", ctx);
      assert.equal(out?.text, "  a\n\t b");
    });

    test('no-op when no trailing whitespace', () => {
      const out = rule("trim-trailing-whitespace", mod).run("a\nb", ctx);
      assert.equal(out, null);
    });
  });

  describe('collapse-blank-runs', () => {
    test('collapses 3+ blank lines to 1', () => {
      const out = rule("collapse-blank-runs", mod).run("a\n\n\n\nb", ctx);
      assert.equal(out?.text, "a\n\nb");
    });

    test('keeps single and double blank lines as-is except at edges', () => {
      // double blank between paragraphs stays (run < 3), but trailing blanks trim
      const out = rule("collapse-blank-runs", mod).run("a\n\nb\n\n", ctx);
      assert.equal(out?.text, "a\n\nb");
    });

    test('trims leading and trailing blank lines', () => {
      const out = rule("collapse-blank-runs", mod).run("\n\n\na\n", ctx);
      assert.equal(out?.text, "a");
    });

    test('treats whitespace-only lines as blank', () => {
      const out = rule("collapse-blank-runs", mod).run("a\n   \n  \n  \nb", ctx);
      assert.equal(out?.text, "a\n\nb");
    });

    test('normalizes non-ASCII whitespace-only lines (NBSP) to empty', () => {
      // U+00A0 is whitespace to String.trim but NOT stripped by
      // trim-trailing-whitespace (ASCII-only), so this rule must own it.
      const out = rule("collapse-blank-runs", mod).run("a\n\u00A0\nb", ctx);
      assert.equal(out?.text, "a\n\nb");
    });

    test('no-op on single-line input', () => {
      const out = rule("collapse-blank-runs", mod).run("a", ctx);
      assert.equal(out, null);
    });
  });

  describe('minify-json', () => {
    test('minifies pretty JSON object', () => {
      const pretty = '{\n  "a": 1,\n  "b": [2, 3]\n}';
      const out = rule("minify-json", mod).run(pretty, ctx);
      assert.equal(out?.text, '{"a":1,"b":[2,3]}');
    });

    test('minifies pretty JSON array', () => {
      const out = rule("minify-json", mod).run('[\n  1,\n  2\n]', ctx);
      assert.equal(out?.text, '[1,2]');
    });

    test('preserves trailing newline from the tool output', () => {
      const out = rule("minify-json", mod).run('{\n  "a": 1\n}\n', ctx);
      assert.equal(out?.text, '{"a":1}\n');
    });

    test('falls back to raw on invalid JSON (uncertain → keep)', () => {
      const out = rule("minify-json", mod).run('{ not json', ctx);
      assert.equal(out, null);
    });

    test('does not fire on non-JSON-leading text', () => {
      const out = rule("minify-json", mod).run('total 42\n', ctx);
      assert.equal(out, null);
    });

    test('no-op when already compact', () => {
      const out = rule("minify-json", mod).run('{"a":1}', ctx);
      assert.equal(out, null);
    });

    test('semantically identical (round-trips to same value)', () => {
      const pretty = '{\n  "nested": {\n    "x": [1, 2, 3]\n  }\n}';
      const out = rule("minify-json", mod).run(pretty, ctx);
      assert.deepEqual(JSON.parse(out!.text), JSON.parse(pretty));
    });
  });
});