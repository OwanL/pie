import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// tsx compiles .ts files to CJS where __dirname is available (import.meta.url is not).
declare const __dirname: string;

interface RawModelConfig {
  providers?: Record<string, {
    models?: Array<{ id?: unknown; cost?: unknown }>;
    modelOverrides?: Record<string, { cost?: unknown }>;
  }>;
}

interface RawProfileEntry {
  id?: string;
  eligible?: unknown;
  precision?: number;
  creativity?: number;
  thoroughness?: number;
  reasoning?: number;
  disabled_reason?: string;
}

interface RawProfileConfig {
  profiles?: RawProfileEntry[];
}

function loadYaml(filePath: string): RawProfileConfig {
  const text = fs.readFileSync(filePath, 'utf8');
  // Simple YAML parsing: scan for profile entries with key fields.
  // Each profile starts with '- id:' and may span multiple lines.
  const profiles: RawProfileEntry[] = [];
  let current: RawProfileEntry | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const idMatch = line.match(/^\s+-\s+id:\s+(.+)$/);
    if (idMatch) {
      if (current) profiles.push(current);
      current = { id: idMatch[1].trim() };
      continue;
    }
    if (!current) continue;

    const numMatch = line.match(/^\s+(precision|creativity|thoroughness|reasoning):\s+(-?[\d.]+)/);
    if (numMatch) {
      (current as Record<string, unknown>)[numMatch[1]] = Number(numMatch[2]);
      continue;
    }
    const boolMatch = line.match(/^\s+eligible:\s+(true|false)/);
    if (boolMatch) {
      current.eligible = boolMatch[1] === 'true';
      continue;
    }
    const reasonMatch = line.match(/^\s+disabled_reason:\s+(.+)/);
    if (reasonMatch) {
      current.disabled_reason = reasonMatch[1].trim();
      continue;
    }
  }
  if (current) profiles.push(current);
  return { profiles };
}

function readConfig(repoRoot: string): RawProfileConfig {
  const yamlPath = path.join(repoRoot, 'model-profiles.yaml');
  if (fs.existsSync(yamlPath)) return loadYaml(yamlPath);
  return readJson<RawProfileConfig>(path.join(repoRoot, 'model-profiles.json'));
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/** All model ids declared in models.json across every provider, including both
 *  `models[].id` entries and `modelOverrides` keys. Provider-agnostic. */
function collectAllModelIds(models: RawModelConfig): Set<string> {
  const ids = new Set<string>();
  for (const provider of Object.values(models.providers ?? {})) {
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        if (typeof model.id === 'string') ids.add(model.id);
      }
    }
    if (provider.modelOverrides && typeof provider.modelOverrides === 'object') {
      for (const id of Object.keys(provider.modelOverrides)) ids.add(id);
    }
  }
  return ids;
}

/** All profile ids declared in model-profiles.{yaml,json}. */
function collectProfileIds(profiles: RawProfileConfig): Set<string> {
  return new Set(
    Array.isArray(profiles.profiles)
      ? profiles.profiles
          .map((profile) => (typeof profile.id === 'string' ? profile.id : null))
          .filter((id): id is string => id !== null)
      : [],
  );
}

test('every configured model has a matching model profile entry', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const models = readJson<RawModelConfig>(path.join(repoRoot, 'models.json'));
  const profiles = readConfig(repoRoot);

  // Forward coverage: every model declared anywhere in models.json (any
  // provider, as a `models` entry or an override) must have a profile entry.
  const modelIds = collectAllModelIds(models);
  const profileIds = collectProfileIds(profiles);

  const missing = [...modelIds].filter((id) => !profileIds.has(id));
  assert.deepEqual(missing, [], `Missing model profiles for: ${missing.join(', ')}`);
});

// --- NEW: reverse coverage and pricing validation tests ---

test('every eligible model profile has real pricing in models.json', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const models = readJson<RawModelConfig>(path.join(repoRoot, 'models.json'));
  const profiles = readConfig(repoRoot);

  // Build set of model ids that have explicit pricing in models.json (zero counts as known/free)
  const pricedModelIds = new Set<string>();
  for (const provider of Object.values(models.providers ?? {})) {
    const modelList = Array.isArray(provider.models) ? provider.models : [];
    const overrides = provider.modelOverrides && typeof provider.modelOverrides === 'object'
      ? Object.entries(provider.modelOverrides)
      : [];
    for (const model of modelList) {
      if (typeof model.id !== 'string') continue;
      const cost = model.cost;
      if (cost && typeof cost === 'object' && !Array.isArray(cost)) {
        const c = cost as Record<string, unknown>;
        const hasPricing = (typeof c.input === 'number' && Number.isFinite(c.input)) ||
                           (typeof c.output === 'number' && Number.isFinite(c.output));
        if (hasPricing) pricedModelIds.add(model.id);
      }
    }
    for (const [id, override] of overrides) {
      const cost = (override as Record<string, unknown>).cost;
      if (cost && typeof cost === 'object' && !Array.isArray(cost)) {
        const c = cost as Record<string, unknown>;
        const hasPricing = (typeof c.input === 'number' && Number.isFinite(c.input)) ||
                           (typeof c.output === 'number' && Number.isFinite(c.output));
        if (hasPricing) pricedModelIds.add(id);
      }
    }
  }

  const profileList = Array.isArray(profiles.profiles) ? profiles.profiles : [];
  const missingCoverage: string[] = [];

  for (const profile of profileList) {
    if (typeof profile.id !== 'string') continue;
    const id = profile.id;

    // Local ollama models: :latest suffix = free, no pricing needed
    if (id.includes(':latest')) continue;

    // Has real pricing?
    if (pricedModelIds.has(id)) continue;

    // Has explicit eligible=false (disabled models don't need pricing)
    if (profile.eligible === false) continue;

    missingCoverage.push(id);
  }

  assert.deepEqual(missingCoverage, [],
    `Eligible models without pricing in models.json: ${missingCoverage.join(', ')}`);
});

test('every model profile id exists in models.json', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const models = readJson<RawModelConfig>(path.join(repoRoot, 'models.json'));
  const profiles = readConfig(repoRoot);

  // Reverse coverage: every profile must reference a model declared somewhere
  // in models.json (under any provider, as a `models` entry or an override).
  // This is the provider-agnostic dual of the forward coverage test above and
  // catches orphan/stale profile entries regardless of provider layout.
  const modelIds = collectAllModelIds(models);
  const profileIds = collectProfileIds(profiles);

  const orphan = [...profileIds].filter((id) => !modelIds.has(id));
  assert.deepEqual(orphan, [],
    `Model profile ids with no matching entry in models.json: ${orphan.join(', ')}`);
});

test('no non-local cloud model has silently-zero pricing in models.json', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const models = readJson<RawModelConfig>(path.join(repoRoot, 'models.json'));

  const suspiciousZeroModels: string[] = [];
  for (const [providerName, provider] of Object.entries(models.providers ?? {})) {
    if (!Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (typeof model.id !== 'string') continue;
      // Local models are fine as zero
      if (model.id.includes(':latest')) continue;

      const cost = model.cost;
      if (!cost || typeof cost !== 'object' || Array.isArray(cost)) continue;
      const c = cost as Record<string, unknown>;
      const isCloud = model.id.includes(':cloud') || providerName === 'github-copilot';
      if (!isCloud) continue;

      const allZero =
        (typeof c.input !== 'number' || c.input === 0) &&
        (typeof c.output !== 'number' || c.output === 0);

      if (allZero) {
        // Known exceptions: grok has no published token pricing. Umans models are
        // subscription (unlimited tokens → $0 marginal cost) and are skipped above
        // (not :cloud / github-copilot). gemini-3-flash-preview:cloud now has live
        // OpenRouter pricing and is no longer an exception.
        const knownUnknowns = new Set(['grok-code-fast-1']);
        if (!knownUnknowns.has(model.id)) {
          suspiciousZeroModels.push(`${model.id} (${providerName})`);
        }
      }
    }
  }

  assert.deepEqual(suspiciousZeroModels, [],
    `Cloud/Copilot models with all-zero pricing (should have real pricing or be listed as known-unknown): ${suspiciousZeroModels.join(', ')}`);
});

test('all profile capability scores are non-negative integers', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const profiles = readConfig(repoRoot);

  const dims = ['precision', 'creativity', 'thoroughness', 'reasoning'] as const;
  const invalidProfiles: string[] = [];

  for (const profile of (Array.isArray(profiles.profiles) ? profiles.profiles : [])) {
    if (typeof profile.id !== 'string') continue;
    for (const dim of dims) {
      const v = profile[dim];
      if (typeof v === 'number' && (!Number.isFinite(v) || v < 0 || !Number.isInteger(v))) {
        invalidProfiles.push(`${profile.id}.${dim}=${v}`);
      }
      // Skip profiles without scores (they'll be flagged by the coverage test instead)
    }
  }

  assert.deepEqual(invalidProfiles, [],
    `Profiles with invalid capability scores: ${invalidProfiles.join(', ')}`);
});
