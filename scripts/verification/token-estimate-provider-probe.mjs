// Opt-in live probe: public shipped tool schemas and synthetic prompts only. Run:
//   proto run node -- scripts/verification/token-estimate-provider-probe.mjs --run --sdk-node-modules <path>
// The SDK node_modules path is required (CLI flag or PIE_PROBE_SDK_NODE_MODULES);
// no user-specific default is built in.
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';
import { measurementError } from './token-estimate-synthetic-fixtures.mjs';

if (!process.argv.includes('--run')) {
  console.log('Live provider probe is opt-in: pass --run (8 requests, 60s each, no retries) and --sdk-node-modules <path>. Add --variants for the isolated annotation-variant mode (9 requests, baseline plus single-tool stripped variants).');
  process.exit(0);
}
const argIndex = process.argv.indexOf('--sdk-node-modules');
const sdk = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.PIE_PROBE_SDK_NODE_MODULES;
if (!sdk) {
  console.error('Missing SDK path: pass --sdk-node-modules <path> or set PIE_PROBE_SDK_NODE_MODULES.');
  process.exit(1);
}
const report = { timestamp: new Date().toISOString(), bounds: { maxRequests: 8, timeoutMs: 60000, maxRetries: 0, maxOutputTokens: 32, reasoning: 'low' }, requests: [], pairs: [] };
const output = join(tmpdir(), `pie-token-provider-probe-${Date.now()}.json`);
let phase = 'initialization';
try {
  // Production model-aware estimate versus frozen compact-JSON comparators.
  const require = createRequire(import.meta.url);
  const encodeOptions = { disallowedSpecial: new Set() };
  const cl100k = require('gpt-tokenizer/encoding/cl100k_base');
  const o200k = require('gpt-tokenizer/encoding/o200k_base');
  const count = (tokenizer, text) => (typeof text === 'string' && text ? (tokenizer.countTokens(text, encodeOptions) ?? tokenizer.encode(text, encodeOptions).length) : 0);
  const chars4 = (text) => (typeof text === 'string' && text.length > 0 ? Math.ceil(text.length / 4) : 0);

  const { estimateRequestPrefixTokens: estimate } = await tsImport('../../lib/request-token-estimate.ts', import.meta.url);
  const { ensureCopilotHeaders, withCopilotOptions } = await tsImport('../../harness/model-providers/authentication/copilot-headers.ts', import.meta.url);

  const settings = JSON.parse(await readFile(resolve('settings.json'), 'utf8'));
  phase = 'authentication';
  // Auth location: explicit env dir, else the OS per-user local app data root. No user-specific hardcode.
  const authBase = process.env.PI_CODING_AGENT_AUTH_DIR ?? process.env.LOCALAPPDATA;
  if (!authBase) throw new Error('auth location unavailable: set PI_CODING_AGENT_AUTH_DIR or LOCALAPPDATA');
  const authPath = process.env.PI_CODING_AGENT_AUTH_DIR ? join(authBase, 'auth.json') : join(authBase, 'pie', 'auth.json');
  const { AuthStorage, ModelRegistry, createReadTool, createWriteTool, createEditTool, createBashTool } = await import(pathToFileURL(join(sdk, '@earendil-works/pi-coding-agent/dist/index.js')).href);
  const { completeSimple } = await import(pathToFileURL(join(sdk, '@earendil-works/pi-ai/dist/compat.js')).href);
  const auth = AuthStorage.inMemory(JSON.parse(await readFile(authPath, 'utf8')));
  const registry = ModelRegistry.create(auth, resolve('models.json'));
  const rawModel = registry.find(settings.defaultProvider, settings.defaultModel);
  if (!rawModel) throw new Error('model unavailable');
  const model = ensureCopilotHeaders(rawModel);
  report.route = { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl };
  const apiKey = await auth.getApiKey(model.provider, { includeFallback: false });
  if (!apiKey) throw new Error('auth unavailable');
  phase = 'loading public tool schemas';
  const { askUserSchema } = await tsImport('../../harness/tools/ask-user/types.ts', import.meta.url);
  const ask = { name: 'ask_user', description: 'Ask one clarifying question with preset answers and an optional free-form reply.', parameters: askUserSchema };
  phase = 'constructing public builtin tools';
  const builtins = [createReadTool, createWriteTool, createEditTool, createBashTool].map(create => create(process.cwd())).map(({ name, description, parameters }) => ({ name, description, parameters }));
  const empty = { systemPrompt: 'Reply OK no tools', tools: [] };
  const prefix = tools => ({ ...empty, tools });
  const fixtures = builtins.concat(ask).map(t => [t.name, prefix([t]), empty]);
  fixtures.push(['shipped catalog pruning', prefix([...builtins, ask]), prefix([builtins[0], ask])]);
  report.catalog = [...builtins, ask];

  // Opt-in isolated-variant mode (--variants): decompose the annotation cost
  // on one bounded live run (baseline plus <=8 single-tool fixtures, each pair
  // measured against the shared empty baseline). Only supported-annotation
  // comment rendering is evaluated; the default fixture mode above is
  // unchanged. wakeup_timer is the distinct shipped constrained tool; its
  // unknown semantics (oneOf/allOf/const) still take compact fallback.
  if (process.argv.includes('--variants')) {
    report.mode = 'annotation-variants';
    report.bounds.maxRequests = 9;
    // Variant mode replaces the default fixture list: baseline plus the seven
    // single-tool variants stay within the 9-request bound.
    fixtures.length = 0;
    report.catalog = [];
    const CONSTRAINT_KEYS = ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum'];
    const ANNOTATION_KEYS = [...CONSTRAINT_KEYS, 'default'];
    // Deep strip of annotation keys at every schema level.
    const strip = (schema, keys) => {
      const copy = structuredClone(JSON.parse(JSON.stringify(schema)));
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        for (const key of keys) delete node[key];
        if (node.properties) Object.values(node.properties).forEach(walk);
        if (node.items) walk(node.items);
      };
      walk(copy);
      return copy;
    };
    const obj = (properties = {}, required = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
    const str = (description) => ({ type: 'string', description });
    const syntheticBoundedParameters = obj({
      label: { type: 'string', minLength: 3, maxLength: 32, description: 'Short label.' },
      ratio: { type: 'number', minimum: 0.25, maximum: 4, description: 'Scale factor.' },
      steps: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'Step count.' },
      tags: { type: 'array', minItems: 1, maxItems: 4, items: str('Lowercase tag token.') },
    }, ['label', 'ratio', 'steps'], { additionalProperties: false });
    const { deferTriggerSchema } = await tsImport('../../harness/tools/deferred-triggers/types.ts', import.meta.url);
    // Shipped public description (same convention as the ask_user fixture
    // above; the extension module has runtime deps tsImport cannot traverse).
    const wakeupDescription = 'Register, list, or cancel durable triggers that deliver a message to a session after a timer, user input, another session finishes, or a periodic predicate. Registration never ends this turn. All actions require the calling session\'s persisted JSONL path, so in-memory subagent sessions are not supported.';
    const wakeupTool = { name: 'wakeup_timer', description: wakeupDescription, parameters: deferTriggerSchema };
    const askVariants = [
      ['ask_user variant: full', askUserSchema],
      ['ask_user variant: strip constraints', strip(askUserSchema, CONSTRAINT_KEYS)],
      ['ask_user variant: strip itemdesc', (() => { const copy = structuredClone(askUserSchema); delete copy.properties.options.items.description; return copy; })()],
      ['ask_user variant: strip defaults', strip(askUserSchema, ['default'])],
    ];
    const syntheticVariants = [
      ['synthetic_bounded: full annotations', syntheticBoundedParameters],
      ['synthetic_bounded: stripped annotations', strip(syntheticBoundedParameters, ANNOTATION_KEYS)],
    ];
    const variantTools = askVariants.map(([label, schema]) => ({ name: 'ask_user', description: ask.description, parameters: schema }));
    report.variantTools = [...variantTools, { name: 'synthetic_bounded', description: 'Inspect bounded synthetic ranges.', parameters: syntheticBoundedParameters }, wakeupTool];
    for (const [label, schema] of askVariants) fixtures.push([label, prefix([{ name: 'ask_user', description: ask.description, parameters: schema }]), empty]);
    for (const [label, schema] of syntheticVariants) fixtures.push([label, prefix([{ name: 'synthetic_bounded', description: 'Inspect bounded synthetic ranges.', parameters: schema }]), empty]);
    fixtures.push(['wakeup_timer: full', prefix([wakeupTool]), empty]);
  }

  // Local estimates on identical serializer bases for one prefix.
  function localBases(prefix) {
    const json = JSON.stringify(prefix.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
    return {
      production: estimate(prefix.systemPrompt, prefix.tools, model),
      cl100k: count(cl100k, prefix.systemPrompt) + (prefix.tools.length ? count(cl100k, json) : 0),
      o200k: count(o200k, prefix.systemPrompt) + count(o200k, json),
      chars4: chars4(prefix.systemPrompt) + chars4(json),
    };
  }

  // Sanitized outgoing payload analysis (public schemas/synthetic prompts only; no headers are
  // captured). Split into the text portion (instructions + input messages) and
  // the schema portion (tool definitions) to separate serializer effects from
  // tokenizer-basis effects.
  let lastPayload = null;
  function analyzePayload(prefix) {
    if (!lastPayload || typeof lastPayload !== 'object') return null;
    const whole = JSON.stringify(lastPayload);
    const text = [typeof lastPayload.instructions === 'string' ? lastPayload.instructions : '', JSON.stringify(lastPayload.input ?? [])].join('');
    const parts = { whole, text, schema: JSON.stringify(lastPayload.tools ?? []) };
    return {
      chars: { whole: whole.length, text: parts.text.length, schema: parts.schema.length },
      tokens: {
        cl100k: { whole: count(cl100k, parts.whole), text: count(cl100k, parts.text), schema: count(cl100k, parts.schema) },
        o200k: { whole: count(o200k, parts.whole), text: count(o200k, parts.text), schema: count(o200k, parts.schema) },
        chars4: { whole: chars4(parts.whole), text: chars4(parts.text), schema: chars4(parts.schema) },
      },
      wireToolFields: Array.isArray(lastPayload.tools) && lastPayload.tools.length > 0 ? Object.keys(lastPayload.tools[0]) : null,
      wireToolStrict: Array.isArray(lastPayload.tools) && lastPayload.tools.length > 0 ? lastPayload.tools[0].strict : null,
    };
  }

  async function request(label, prefix) {
    phase = `request ${report.requests.length + 1}`;
    if (report.requests.length >= report.bounds.maxRequests) throw new Error('request bound');
    lastPayload = null;
    const row = { label, local: localBases(prefix), observed: null };
    report.requests.push(row);
    const result = await completeSimple(model, { ...prefix, messages: [{ role: 'user', content: 'Reply OK. Do not call tools.', timestamp: 0 }] }, withCopilotOptions({ apiKey, reasoning: 'low', maxTokens: 32, maxRetries: 0, signal: AbortSignal.timeout(60000), transport: 'sse', onPayload: async (params) => { lastPayload = params; return undefined; } }, model));
    row.stopReason = result.stopReason;
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('provider request failed');
    const usage = result.usage;
    if (usage) {
      row.usage = { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
      const total = usage.input + usage.cacheRead + usage.cacheWrite;
      if (Number.isFinite(total) && total > 0) row.observed = total;
    }
    row.usageAvailable = row.observed !== null;
    row.payload = analyzePayload(prefix);
    if (report.wireToolFields === undefined && row.payload?.wireToolFields) {
      report.wireToolFields = row.payload.wireToolFields;
      report.wireToolStrict = row.payload.wireToolStrict;
    }
    return row;
  }
  const baseline = await request('empty baseline', empty);
  for (const [name, full, pruned] of fixtures) {
    const f = await request(`${name}: full`, full);
    const p = pruned.tools.length === 0 ? baseline : await request(`${name}: pruned`, pruned);
    const deltaOf = (a, b) => (a != null && b != null ? a - b : null);
    const relative = (local, observed) => observed === null || observed === 0 ? null : (local - observed) / Math.abs(observed);
    const pair = {
      name,
      observedFull: f.observed,
      observedPruned: p.observed,
      observedDelta: deltaOf(f.observed, p.observed),
      baselineAdjustedFull: baseline.observed !== null && f.observed !== null ? f.observed - baseline.observed : null,
      baselineAdjustedPruned: baseline.observed !== null && p.observed !== null ? p.observed - baseline.observed : null,
      localFull: f.local,
      localPruned: p.local,
      localDelta: { production: deltaOf(f.local.production, p.local.production), cl100k: deltaOf(f.local.cl100k, p.local.cl100k), o200k: deltaOf(f.local.o200k, p.local.o200k), chars4: deltaOf(f.local.chars4, p.local.chars4) },
      payloadFull: f.payload,
      payloadPruned: p.payload,
    };
    const pd = (basis, part) => {
      if (!f.payload || !p.payload) return null;
      const a = f.payload.tokens[basis][part];
      const b = p.payload.tokens[basis][part];
      return a != null && b != null ? a - b : null;
    };
    pair.payloadDelta = {
      cl100k: { whole: pd('cl100k', 'whole'), text: pd('cl100k', 'text'), schema: pd('cl100k', 'schema') },
      o200k: { whole: pd('o200k', 'whole'), text: pd('o200k', 'text'), schema: pd('o200k', 'schema') },
      chars4: { whole: pd('chars4', 'whole'), text: pd('chars4', 'text'), schema: pd('chars4', 'schema') },
    };
    pair.errors = Object.fromEntries(['production', 'cl100k', 'o200k', 'chars4'].map(basis => [basis, {
      fullPrefix: measurementError(pair.localFull[basis] - baseline.local[basis], pair.baselineAdjustedFull),
      savings: measurementError(pair.localDelta[basis], pair.observedDelta),
    }]));
    pair.pass = pair.errors.production.fullPrefix.pass === true && pair.errors.production.savings.pass === true;
    pair.relativeError = {
      localCl100kFull: relative(pair.localFull.cl100k - baseline.local.cl100k, pair.baselineAdjustedFull),
      localCl100kDelta: relative(pair.localDelta.cl100k, pair.observedDelta),
      localO200kFull: relative(pair.localFull.o200k - baseline.local.o200k, pair.baselineAdjustedFull),
      localO200kDelta: relative(pair.localDelta.o200k, pair.observedDelta),
      localChars4Full: relative(pair.localFull.chars4 - baseline.local.chars4, pair.baselineAdjustedFull),
      localChars4Delta: relative(pair.localDelta.chars4, pair.observedDelta),
      payloadCl100kDelta: relative(pair.payloadDelta.cl100k.whole, pair.observedDelta),
      payloadO200kDelta: relative(pair.payloadDelta.o200k.whole, pair.observedDelta),
      payloadCl100kSchemaDelta: relative(pair.payloadDelta.cl100k.schema, pair.observedDelta),
      payloadO200kSchemaDelta: relative(pair.payloadDelta.o200k.schema, pair.observedDelta),
      payloadCl100kTextDelta: relative(pair.payloadDelta.cl100k.text, pair.observedDelta),
      payloadO200kTextDelta: relative(pair.payloadDelta.o200k.text, pair.observedDelta),
    };
    report.pairs.push(pair);
  }
  report.threshold = 'Each production full prefix (baseline-adjusted) and savings: absolute error <=16 tokens OR relative error <=10%';
  report.passed = report.pairs.every(pair => pair.pass);
  report.status = 'completed';
  if (!report.passed) process.exitCode = 1;
} catch {
  // Provider errors may contain headers, tokens or echoed payloads: never emit them.
  report.status = 'blocked';
  report.blocker = `Unavailable during ${phase}; raw error suppressed to protect credentials.`;
  process.exitCode = 1;
}
report.actualRequests = report.requests.length;
report.finishedAt = new Date().toISOString();
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: output, ...report }, null, 2));