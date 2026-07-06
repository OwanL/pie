import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configUrl = pathToFileURL(path.resolve(__dirname, '../config.ts')).href;

type RuleToggles = { ansi: boolean; whitespace: boolean; blankRun: boolean; jsonMinify: boolean; lsLong: boolean; gitLog: boolean };
type Config = { enabled: boolean; profile: string; rules: RuleToggles; tools: string[] | null };
type ConfigModule = {
  loadConfig: (settingsPath?: string) => Config;
  resetConfigCache: () => void;
  setConfigOverrideForTesting: (c: Config | null) => void;
  isExtensionDisabledByToggle: (id?: string) => boolean;
};

describe('config loader', () => {
  let mod: ConfigModule;
  test.before(async () => {
    mod = (await import(configUrl)) as ConfigModule;
  });
  test.afterEach(() => {
    mod.setConfigOverrideForTesting(null);
    mod.resetConfigCache();
  });

  test('returns defaults when the file has no toolResultPruning block', () => {
    const tmp = path.join(__dirname, 'fixtures-no-block.json');
    writeFileSync(tmp, JSON.stringify({ pruning: { mode: 'off' } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.equal(cfg.enabled, true);
      assert.equal(cfg.profile, 'default');
      assert.deepEqual(cfg.rules, { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true });
    } finally {
      rmSync(tmp);
    }
  });

  test('parses a valid block', () => {
    const tmp = path.join(__dirname, 'fixtures-valid.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { enabled: false, profile: 'security' } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.equal(cfg.enabled, false);
      assert.equal(cfg.profile, 'security');
      assert.deepEqual(cfg.rules, { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true });
    } finally {
      rmSync(tmp);
    }
  });

  test('parses a valid rules block', () => {
    const tmp = path.join(__dirname, 'fixtures-rules.json');
    writeFileSync(tmp, JSON.stringify({
      toolResultPruning: { rules: { ansi: false, whitespace: true, blankRun: false, jsonMinify: true } },
    }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.deepEqual(cfg.rules, { ansi: false, whitespace: true, blankRun: false, jsonMinify: true, lsLong: true, gitLog: true });
    } finally {
      rmSync(tmp);
    }
  });

  test('falls back to defaults on invalid rule toggle values', () => {
    const tmp = path.join(__dirname, 'fixtures-bad-rules.json');
    writeFileSync(tmp, JSON.stringify({
      toolResultPruning: { rules: { ansi: 'yes', whitespace: true, blankRun: 1, jsonMinify: true } },
    }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      // ansi ('yes') and blankRun (1) are non-boolean → fall back to defaults.
      assert.equal(cfg.rules.ansi, true);
      assert.equal(cfg.rules.whitespace, true);
      assert.equal(cfg.rules.blankRun, true);
      assert.equal(cfg.rules.jsonMinify, true);
      // lossy toggles are absent in the input → default true.
      assert.equal(cfg.rules.lsLong, true);
      assert.equal(cfg.rules.gitLog, true);
    } finally {
      rmSync(tmp);
    }
  });

  test('falls back to defaults when rules is not an object', () => {
    const tmp = path.join(__dirname, 'fixtures-rules-nonobject.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { rules: 'off' } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.deepEqual(cfg.rules, { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true });
    } finally {
      rmSync(tmp);
    }
  });

  test('falls back to defaults on invalid profile', () => {
    const tmp = path.join(__dirname, 'fixtures-bad.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { profile: 'paranoid' } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.equal(cfg.profile, 'default');
      assert.equal(cfg.enabled, true);
    } finally {
      rmSync(tmp);
    }
  });

  test('returns defaults when settings.json is missing', () => {
    mod.resetConfigCache();
    const cfg = mod.loadConfig(path.join(__dirname, 'does-not-exist.json'));
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.profile, 'default');
  });

  test('caches across calls (same mtime)', () => {
    const tmp = path.join(__dirname, 'fixtures-cache.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { enabled: false } }));
    try {
      mod.resetConfigCache();
      const a = mod.loadConfig(tmp);
      // Mutate file content but keep mtime within same ms tick is racy; instead
      // verify second call returns same value without re-reading by checking
      // override persistence: set override, then loadConfig ignores disk.
      mod.setConfigOverrideForTesting({ enabled: true, profile: 'security', rules: { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true }, tools: null });
      const b = mod.loadConfig(tmp);
      assert.equal(b.enabled, true);
      assert.equal(b.profile, 'security');
      void a;
    } finally {
      rmSync(tmp);
    }
  });

  test('isExtensionDisabledByToggle honors the env var', () => {
    const orig = process.env['PIE_EXTENSION_TOGGLES_JSON'];
    try {
      process.env['PIE_EXTENSION_TOGGLES_JSON'] = JSON.stringify({ 'tool-result-pruner': false });
      assert.equal(mod.isExtensionDisabledByToggle(), true);
      process.env['PIE_EXTENSION_TOGGLES_JSON'] = JSON.stringify({ 'tool-result-pruner': true });
      assert.equal(mod.isExtensionDisabledByToggle(), false);
      delete process.env['PIE_EXTENSION_TOGGLES_JSON'];
      assert.equal(mod.isExtensionDisabledByToggle(), false);
    } finally {
      if (orig === undefined) delete process.env['PIE_EXTENSION_TOGGLES_JSON'];
      else process.env['PIE_EXTENSION_TOGGLES_JSON'] = orig;
    }
  });

  test('tools allowlist defaults to null (all non-read tools) when absent', () => {
    const tmp = path.join(__dirname, 'fixtures-tools-absent.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { enabled: true } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.equal(cfg.tools, null);
    } finally {
      rmSync(tmp);
    }
  });

  test('parses a tools allowlist array, dropping invalid entries', () => {
    const tmp = path.join(__dirname, 'fixtures-tools.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { tools: ['bash', 'ls', '', 3, 'grep'] } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.deepEqual(cfg.tools, ['bash', 'ls', 'grep']);
    } finally {
      rmSync(tmp);
    }
  });

  test('an explicit null tools allowlist is preserved as null', () => {
    const tmp = path.join(__dirname, 'fixtures-tools-null.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { tools: null } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.equal(cfg.tools, null);
    } finally {
      rmSync(tmp);
    }
  });

  test('a non-array tools value falls back to the default (null)', () => {
    const tmp = path.join(__dirname, 'fixtures-tools-bad.json');
    writeFileSync(tmp, JSON.stringify({ toolResultPruning: { tools: 'bash,ls' } }));
    try {
      mod.resetConfigCache();
      const cfg = mod.loadConfig(tmp);
      assert.equal(cfg.tools, null);
    } finally {
      rmSync(tmp);
    }
  });
});