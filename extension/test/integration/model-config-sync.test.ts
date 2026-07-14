import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// tsx compiles .ts test files to CJS where __dirname is available.
declare const __dirname: string;

// Resolve the `yaml` package from the extension's node_modules (no root deps).
const requireFromExtension = createRequire(
  pathToFileURL(path.join(__dirname, '..', '..', 'package.json')).href,
);
const YAML: { parse: (raw: string) => unknown } = requireFromExtension('yaml');

// The sync script lives at <repoRoot>/scripts/sync-models.mjs and is plain ESM,
// so we dynamic-import it (tsx handles .mjs natively; import.meta.url inside it
// resolves to the real file path).
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const syncScriptPath = path.join(repoRoot, 'scripts', 'sync-models.mjs');

interface SyncModule {
  generate: (source: unknown, existingSettings: unknown) => {
    modelsJson: unknown;
    modelProfilesYaml: string;
    settingsJson: unknown;
  };
  loadSource: (root?: string) => unknown;
  loadAndGenerate: (root?: string) => {
    modelsJson: unknown;
    modelProfilesYaml: string;
    settingsJson: unknown;
  };
}

async function loadSyncModule(): Promise<SyncModule> {
  return (await import(pathToFileURL(syncScriptPath).href)) as SyncModule;
}

function readText(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Parse a committed derived file (JSON or YAML) into a JS value. */
function parseCommitted(rel: string): unknown {
  const text = readText(rel);
  if (rel.endsWith('.json')) return JSON.parse(text);
  return YAML.parse(text);
}

test('models.yaml validates against models.schema.json and loads', async () => {
  const mod = await loadSyncModule();
  const source = mod.loadSource(repoRoot);
  assert.ok(source, 'loadSource should return a parsed source object');
});

test('generated models.json matches the committed models.json', async () => {
  const mod = await loadSyncModule();
  const out = await mod.loadAndGenerate(repoRoot);
  const committed = parseCommitted('models.json');
  assert.deepStrictEqual(out.modelsJson, committed, 'models.json drift');
});

test('generated model-profiles.yaml matches the committed file', async () => {
  const mod = await loadSyncModule();
  const out = await mod.loadAndGenerate(repoRoot);
  const committed = parseCommitted('model-profiles.yaml');
  const generated = YAML.parse(out.modelProfilesYaml);
  assert.deepStrictEqual(generated, committed, 'model-profiles.yaml drift');
});

test('generated settings.json matches the committed settings.json (merge preserves non-model fields)', async () => {
  const mod = await loadSyncModule();
  const out = await mod.loadAndGenerate(repoRoot);
  const committed = parseCommitted('settings.json');
  // Full deep-equal: proves the merge overwrote exactly the model keys and
  // left everything else (httpIdleTimeoutMs, packages, lastChangelogVersion,
  // subagent, sessionDir, pruning.tools) untouched.
  assert.deepStrictEqual(out.settingsJson, committed, 'settings.json drift');
});

test('generate() is a pure function: same source + settings => same output', async () => {
  const mod = await loadSyncModule();
  const source = mod.loadSource(repoRoot);
  const existingSettings = parseCommitted('settings.json');
  const a = mod.generate(source, existingSettings);
  const b = mod.generate(source, existingSettings);
  assert.deepStrictEqual(a, b, 'generate() is not deterministic');
});

test('settings.json merge preserves user-selected chat and pruning models while overwriting retry', async () => {
  const mod = await loadSyncModule();
  const source = mod.loadSource(repoRoot);
  // Synthesize a settings base with extra fields that must survive the merge.
  const base = {
    defaultModel: 'OLD',
    defaultProvider: 'OLD',
    defaultThinkingLevel: 'OLD',
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, provider: { maxRetries: 0, maxRetryDelayMs: 0 } },
    httpIdleTimeoutMs: 999,
    packages: ['npm:foo@1.0.0'],
    pruning: {
      model: 'OLD',
      provider: 'OLD',
      thinkingLevel: 'OLD',
      tools: { alwaysKeep: ['read', 'bash'] },
    },
    lastChangelogVersion: '9.9.9',
    subagent: { confirmProjectAgents: true },
    sessionDir: 'data/outcomes/sessions',
  };
  const merged = mod.generate(source, base).settingsJson as Record<string, unknown>;
  const pruning = merged.pruning as Record<string, unknown>;
  // User-owned model keys are PRESERVED (the backend owns them; sync only seeds
  // from models.yaml when absent). They must NOT be overwritten by the merge.
  assert.equal(merged.defaultModel, 'OLD');
  assert.equal(merged.defaultProvider, 'OLD');
  assert.equal(merged.defaultThinkingLevel, 'OLD');
  // Retry is centrally derived, but pruning selection is a runtime user preference.
  assert.deepEqual(merged.retry, (source as { retry: unknown }).retry);
  assert.equal(pruning.model, 'OLD');
  assert.equal(pruning.provider, 'OLD');
  assert.equal(pruning.thinkingLevel, 'OLD');
  // Non-model fields preserved.
  assert.equal(merged.httpIdleTimeoutMs, 999);
  assert.deepEqual(merged.packages, ['npm:foo@1.0.0']);
  assert.equal(merged.lastChangelogVersion, '9.9.9');
  assert.deepEqual(merged.subagent, { confirmProjectAgents: true });
  assert.equal(merged.sessionDir, 'data/outcomes/sessions');
  assert.deepEqual(pruning.tools, { alwaysKeep: ['read', 'bash'] });
  // The legacy `proxy` block (if present in an old settings.json) is stripped.
  assert.equal(merged.proxy, undefined);
});

test('settings.json merge seeds user-owned chat and pruning selections only when absent', async () => {
  const mod = await loadSyncModule();
  const source = mod.loadSource(repoRoot) as {
    defaults: { model: string; provider: string; thinkingLevel: string };
    pruning: { model: string; provider: string; thinkingLevel: string };
  };
  const base = {
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, provider: { maxRetries: 0, maxRetryDelayMs: 0 } },
    pruning: { tools: { ceiling: 7 } },
  };
  const merged = mod.generate(source, base).settingsJson as Record<string, unknown>;
  const pruning = merged.pruning as Record<string, unknown>;
  assert.equal(merged.defaultModel, source.defaults.model);
  assert.equal(merged.defaultProvider, source.defaults.provider);
  assert.equal(merged.defaultThinkingLevel, source.defaults.thinkingLevel);
  assert.equal(pruning.model, source.pruning.model);
  assert.equal(pruning.provider, source.pruning.provider);
  assert.equal(pruning.thinkingLevel, source.pruning.thinkingLevel);
  assert.deepEqual(pruning.tools, { ceiling: 7 });
});
