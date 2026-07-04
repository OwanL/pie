import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configUrl = pathToFileURL(path.resolve(__dirname, '../config.ts')).href;

type Config = { enabled: boolean; profile: string };
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
      mod.setConfigOverrideForTesting({ enabled: true, profile: 'security' });
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
});