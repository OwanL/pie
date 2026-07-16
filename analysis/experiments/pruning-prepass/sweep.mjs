#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(await readFile(path.join(here, 'benchmark.json'), 'utf8'));
const extra = JSON.parse(await readFile(path.join(here, 'benchmark-extra.json'), 'utf8'));
const real = JSON.parse(await readFile(path.join(here, 'benchmark-real.json'), 'utf8'));
let cases = [...base.cases, ...extra.cases];
const productionPrompt = (await readFile(path.resolve(here, '../../../extensions/skill-pruner/pruning-system-prompt.md'), 'utf8'))
  .trim()
  .replace('{{STRATEGY_INSTRUCTION}}', 'Use the greater-than-50-percent probability boundary independently for every candidate. An empty keep list is correct when none is probably needed.');

const prompts = {
  production: productionPrompt,
  causal: [
    'You are pruning capabilities from a coding agent before it starts the current request.',
    'Keep a capability only when removing it would probably prevent or materially hinder an action the agent will take before the request is complete.',
    'Judge actual invocation across the full work arc: understand, inspect, edit, validate, debug, and clean up. Preserve capabilities required by explicit instructions, implied implementation steps, current external research, or a named specialist workflow.',
    'Conversation is evidence only for resolving references and continuing work. A latest-message pivot wins. Do not keep merely plausible or generally useful specialists.',
    'Return only {"keep":[]} with supplied candidate names and no explanation.',
  ].join('\n'),
  minimal: [
    'Which supplied capabilities will the coding agent more likely than not invoke before completing the current request?',
    'Include implied reading, editing, testing, debugging, current web research, and explicitly named workflows. The latest request wins over old context.',
    'Return only {"keep":[]} using supplied names.',
  ].join('\n'),
  frontier: [
    'Select only capabilities more likely than not to be invoked in the agent’s next meaningful action for the latest request.',
    'Use conversation to resolve references; a pivot wins. Return only {"keep":[]} with supplied names.',
  ].join('\n'),
};

const VARIANTS = {
  baseline: { note: 'Current production prompt/input, Ollama model defaults, unconstrained output.' },
  temperature_0: { temperature: 0, note: 'Only set deterministic temperature zero.' },
  temperature_02: { temperature: 0.2, note: 'Only lower temperature to 0.2.' },
  temperature_05: { temperature: 0.5, note: 'Only lower temperature to 0.5.' },
  json_mode: { format: 'json', note: 'Only request Ollama JSON mode.' },
  json_schema_names: { format: 'keep-schema', note: 'Constrain keep-list values to supplied names.' },
  typed_schema: { contract: 'typed', format: 'typed-schema', note: 'Separate keepSkills/keepTools arrays under a dynamic schema.' },
  bit_array_schema: { contract: 'bits', format: 'bits-schema', layout: 'numbered', note: 'Return aligned binary decisions under a fixed-length schema.' },
  opaque_ids_schema: { names: 'ids', format: 'keep-schema', note: 'Use short stable IDs in catalog and output, then map to canonical names.' },
  semantic_aliases: { names: 'semantic', note: 'Add compact semantic aliases after opaque/tool-like names.' },
  compact_80: { descriptions: 'compact80', note: 'Hard-cap every description at 80 characters.' },
  first_sentence: { descriptions: 'sentence', note: 'Keep only the first sentence of every description.' },
  no_descriptions: { descriptions: 'none', note: 'Remove descriptions and classify from names alone.' },
  affordance_descriptions: { descriptions: 'affordance', note: 'Rewrite descriptions into concise can/use-when form.' },
  flat_catalog: { layout: 'flat', note: 'Mix skills and tools into one labelled candidate list.' },
  tools_first: { layout: 'tools-first', note: 'Reverse grouped catalog order so tools precede skills.' },
  shuffled_catalog: { order: 'shuffle', note: 'Shuffle candidate order deterministically per case and seed.' },
  latest_only: { context: 'latest', note: 'Omit all prior dialogue.' },
  user_history: { context: 'users', note: 'Include only recent user messages.' },
  full_history: { context: 'full', note: 'Include older plus recent user and assistant messages.' },
  previous_keep: { context: 'previous', note: 'Add prior keep decisions as weak evidence where available.' },
  causal_prompt: { prompt: 'causal', note: 'Frame relevance as causal hindrance if removed.' },
  minimal_prompt: { prompt: 'minimal', note: 'Use a shorter direct classification instruction.' },
  next_step_frontier: { prompt: 'frontier', note: 'Select only the next action frontier (negative-control hypothesis).' },
};

function parseArgs(argv) {
  const args = {
    endpoint: 'http://127.0.0.1:11434', model: 'qwen3.5:9b',
    variants: Object.keys(VARIANTS), seeds: [101, 202, 303], output: null, suite: 'controlled',
    checkpoint: path.join(here, 'results', 'sweep-checkpoint.jsonl'), timeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]; const value = argv[i + 1];
    if (arg === '--endpoint') { args.endpoint = value.replace(/\/$/, ''); i += 1; }
    else if (arg === '--model') { args.model = value; i += 1; }
    else if (arg === '--variants') { args.variants = value.split(',').filter(Boolean); i += 1; }
    else if (arg === '--seeds') { args.seeds = value.split(',').map(Number); i += 1; }
    else if (arg === '--suite') { args.suite = value; i += 1; }
    else if (arg === '--output') { args.output = path.resolve(value); i += 1; }
    else if (arg === '--checkpoint') { args.checkpoint = path.resolve(value); i += 1; }
    else if (arg === '--timeout-ms') { args.timeoutMs = Number(value); i += 1; }
    else if (arg === '--help') {
      console.log('Usage: node sweep.mjs [--suite controlled|real|all] [--model qwen3.5:9b] [--variants baseline,json_mode] [--seeds 101,202,303] [--checkpoint file.jsonl] [--output file.json]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const variant of args.variants) if (!VARIANTS[variant]) throw new Error(`Unknown variant: ${variant}`);
  if (!['controlled', 'real', 'all'].includes(args.suite)) throw new Error('--suite must be controlled, real, or all');
  if (args.seeds.some((seed) => !Number.isInteger(seed))) throw new Error('Seeds must be integers');
  return args;
}

function hash(text) {
  let value = 2166136261;
  for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

function rng(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function shuffle(items, seed) {
  const result = [...items]; const random = rng(seed);
  for (let i = result.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

function compact(text, mode) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (mode === 'none') return '';
  if (mode === 'compact80') return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77).replace(/\s+\S*$/, '')}…`;
  if (mode === 'sentence') return normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  if (mode === 'affordance') {
    const trigger = normalized.match(/(?:Use|Use only|Best) when\b[^.]*[.]/i)?.[0];
    const first = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
    return trigger && trigger.toLowerCase() !== first.toLowerCase() ? `Can: ${first} ${trigger}` : `Can: ${first}`;
  }
  return normalized;
}

const SEMANTIC_ALIASES = {
  bash: 'run commands/tests', read: 'read local files', edit: 'edit local files', web_search: 'search current web',
  get_search_content: 'open search results', fetch_content: 'fetch known URL', session_review: 'review/close sessions',
  session_changes: 'inspect current diff', subagent: 'delegate parallel work', pi_logs: 'inspect runtime logs',
};

function presentCandidates(testCase, variant, seed) {
  let candidates = testCase.candidates.map((candidate, index) => ({ ...candidate, canonicalIndex: index }));
  if (variant.order === 'shuffle') candidates = shuffle(candidates, seed ^ hash(testCase.id));
  return candidates.map((candidate, index) => {
    const id = `C${String(index + 1).padStart(2, '0')}`;
    const alias = SEMANTIC_ALIASES[candidate.name] ?? candidate.name.replace(/[-_:./]+/g, ' ');
    const outputName = variant.names === 'ids' ? id : candidate.name;
    const displayName = variant.names === 'ids' ? `${id} (${candidate.name})`
      : variant.names === 'semantic' && alias !== candidate.name ? `${candidate.name} (${alias})` : candidate.name;
    return { ...candidate, id, outputName, displayName, shownDescription: compact(candidate.description, variant.descriptions) };
  });
}

function contextLines(testCase, mode = 'dialogue') {
  if (mode === 'latest') return [`User request: "${testCase.request}"`];
  const source = mode === 'full' ? [...(testCase.older ?? []), ...(testCase.recent ?? [])] : [...(testCase.recent ?? [])];
  const messages = mode === 'users' ? source.filter((message) => message.role === 'user') : source;
  const lines = [`User request: "${testCase.request}"`];
  if (messages.length) {
    lines.push('', 'Recent conversation (use this to interpret follow-up requests):');
    for (const message of messages) lines.push(`- ${message.role}: ${message.text}`);
  }
  if (mode === 'previous' && testCase.previousKeep?.length) lines.push('', `Previous prepass kept (weak evidence; re-evaluate): ${testCase.previousKeep.join(', ')}`);
  return lines;
}

function catalogLine(candidate, numbered = false, index = 0) {
  const prefix = numbered ? `${index + 1}. [${candidate.kind}] ` : '- ';
  return `${prefix}${candidate.displayName}${candidate.shownDescription ? `: ${candidate.shownDescription}` : ''}`;
}

function render(testCase, name, seed) {
  const variant = VARIANTS[name]; const candidates = presentCandidates(testCase, variant, seed);
  const lines = contextLines(testCase, variant.context);
  if (variant.layout === 'numbered' || variant.layout === 'flat') {
    lines.push('', `Candidates (${candidates.length}, preserve order):`);
    candidates.forEach((candidate, index) => lines.push(catalogLine(candidate, true, index)));
  } else {
    const kinds = variant.layout === 'tools-first' ? ['tool', 'skill'] : ['skill', 'tool'];
    for (const kind of kinds) {
      lines.push('', kind === 'skill' ? 'Candidate skills:' : 'Candidate tools:');
      candidates.filter((candidate) => candidate.kind === kind).forEach((candidate) => lines.push(catalogLine(candidate)));
    }
  }
  return { system: prompts[variant.prompt ?? 'production'], user: lines.join('\n'), candidates };
}

function dynamicFormat(name, candidates) {
  const variant = VARIANTS[name];
  if (!variant.format) return undefined;
  if (variant.format === 'json') return 'json';
  if (variant.format === 'bits-schema') return {
    type: 'object', properties: { decisions: { type: 'array', items: { type: 'integer', enum: [0, 1] }, minItems: candidates.length, maxItems: candidates.length } }, required: ['decisions'], additionalProperties: false,
  };
  if (variant.format === 'typed-schema') {
    const skills = candidates.filter((candidate) => candidate.kind === 'skill').map((candidate) => candidate.outputName);
    const tools = candidates.filter((candidate) => candidate.kind === 'tool').map((candidate) => candidate.outputName);
    return { type: 'object', properties: {
      keepSkills: { type: 'array', items: { type: 'string', enum: skills }, uniqueItems: true },
      keepTools: { type: 'array', items: { type: 'string', enum: tools }, uniqueItems: true },
    }, required: ['keepSkills', 'keepTools'], additionalProperties: false };
  }
  return { type: 'object', properties: { keep: { type: 'array', items: { type: 'string', enum: candidates.map((candidate) => candidate.outputName) }, uniqueItems: true } }, required: ['keep'], additionalProperties: false };
}

function parse(text, name, presented, canonicalCount) {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const variant = VARIANTS[name];
    let decisions;
    if (variant.contract === 'bits') {
      if (!Array.isArray(value.decisions) || value.decisions.length !== presented.length || value.decisions.some((item) => item !== 0 && item !== 1)) throw new Error('invalid decisions');
      decisions = value.decisions.map((item) => item === 1);
    } else {
      const keep = variant.contract === 'typed' ? [...(value.keepSkills ?? []), ...(value.keepTools ?? [])] : value.keep;
      if (!Array.isArray(keep)) throw new Error('missing keep');
      const known = new Set(presented.map((candidate) => candidate.outputName));
      if (keep.some((item) => typeof item !== 'string' || !known.has(item))) throw new Error('unknown keep name');
      const kept = new Set(keep); decisions = presented.map((candidate) => kept.has(candidate.outputName));
    }
    const canonical = Array(canonicalCount).fill(true);
    presented.forEach((candidate, index) => { canonical[candidate.canonicalIndex] = decisions[index]; });
    return { valid: true, predictedKeep: canonical };
  } catch { return { valid: false, predictedKeep: Array(canonicalCount).fill(true) }; }
}

async function callOllama(args, testCase, name, seed) {
  const variant = VARIANTS[name]; const rendered = render(testCase, name, seed);
  const body = {
    model: args.model, stream: false, keep_alive: '30m', think: false,
    messages: [{ role: 'system', content: rendered.system }, { role: 'user', content: rendered.user }],
    options: { seed, num_predict: 160, ...(variant.temperature !== undefined ? { temperature: variant.temperature } : {}) },
    ...(variant.format ? { format: dynamicFormat(name, rendered.candidates) } : {}),
  };
  const started = performance.now();
  const response = await fetch(`${args.endpoint}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(args.timeoutMs) });
  const wallMs = performance.now() - started;
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const result = await response.json(); const text = result.message?.content ?? '';
  const parsed = parse(text, name, rendered.candidates, testCase.candidates.length);
  return {
    key: `${args.suite}|${args.model}|${name}|${seed}|${testCase.id}`, suite: args.suite, model: args.model, variant: name, seed, caseId: testCase.id,
    valid: parsed.valid, predictedKeep: parsed.predictedKeep, raw: text, wallMs,
    providerMs: result.total_duration / 1e6, loadMs: result.load_duration / 1e6,
    promptTokens: result.prompt_eval_count ?? 0, outputTokens: result.eval_count ?? 0,
    systemChars: rendered.system.length, userChars: rendered.user.length,
  };
}

function quantile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0; }

function score(rows) {
  let tp = 0; let tn = 0; let fp = 0; let fn = 0; let exact = 0;
  for (const row of rows) {
    const testCase = cases.find((item) => item.id === row.caseId); let caseExact = true;
    testCase.candidates.forEach((candidate, index) => {
      const predicted = row.predictedKeep[index];
      if (predicted && candidate.expectedKeep) tp += 1;
      else if (!predicted && !candidate.expectedKeep) tn += 1;
      else if (predicted) { fp += 1; caseExact = false; }
      else { fn += 1; caseExact = false; }
    });
    if (caseExact) exact += 1;
  }
  const total = tp + tn + fp + fn;
  return {
    rows: rows.length, decisions: total, accuracy: (tp + tn) / total, keepRecall: tp / (tp + fn), pruneRecall: tn / (tn + fp),
    falsePrunes: fn, falseKeeps: fp, exactCases: exact, parseFailures: rows.filter((row) => !row.valid).length,
    medianMs: quantile(rows.map((row) => row.wallMs), 0.5), p95Ms: quantile(rows.map((row) => row.wallMs), 0.95),
    meanPromptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0) / rows.length,
    meanOutputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0) / rows.length,
  };
}

function pairedBootstrap(allRows, variantName, iterations = 10_000) {
  if (variantName === 'baseline') return null;
  const baseline = new Map(allRows.filter((row) => row.variant === 'baseline').map((row) => [`${row.seed}|${row.caseId}`, row]));
  const candidate = new Map(allRows.filter((row) => row.variant === variantName).map((row) => [`${row.seed}|${row.caseId}`, row]));
  const units = [];
  for (const testCase of cases) {
    let correctDelta = 0; let falsePruneDelta = 0; let latencyDelta = 0; let count = 0;
    for (const seed of new Set(allRows.map((row) => row.seed))) {
      const a = baseline.get(`${seed}|${testCase.id}`); const b = candidate.get(`${seed}|${testCase.id}`); if (!a || !b) continue;
      const expected = testCase.candidates.map((item) => item.expectedKeep);
      const correct = (row) => row.predictedKeep.reduce((sum, value, index) => sum + Number(value === expected[index]), 0) / expected.length;
      const falsePrunes = (row) => row.predictedKeep.reduce((sum, value, index) => sum + Number(expected[index] && !value), 0);
      correctDelta += correct(b) - correct(a); falsePruneDelta += falsePrunes(b) - falsePrunes(a); latencyDelta += b.wallMs - a.wallMs; count += 1;
    }
    if (count) units.push({ accuracy: correctDelta / count, falsePrunes: falsePruneDelta / count, latencyMs: latencyDelta / count });
  }
  const random = rng(0xC0FFEE ^ hash(variantName)); const samples = { accuracy: [], falsePrunes: [], latencyMs: [] };
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sums = { accuracy: 0, falsePrunes: 0, latencyMs: 0 };
    for (let i = 0; i < units.length; i += 1) { const unit = units[Math.floor(random() * units.length)]; for (const key of Object.keys(sums)) sums[key] += unit[key]; }
    for (const key of Object.keys(sums)) samples[key].push(sums[key] / units.length);
  }
  return Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, { mean: units.reduce((sum, unit) => sum + unit[key], 0) / units.length, low95: quantile(values, 0.025), high95: quantile(values, 0.975) }]));
}

function rounded(value) { return typeof value === 'number' ? Number(value.toFixed(4)) : value; }
function roundDeep(value) { if (Array.isArray(value)) return value.map(roundDeep); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDeep(item)])); return rounded(value); }

async function loadCheckpoint(file) {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

const args = parseArgs(process.argv.slice(2));
cases = args.suite === 'real' ? real.cases : args.suite === 'all' ? [...base.cases, ...extra.cases, ...real.cases] : [...base.cases, ...extra.cases];
await mkdir(path.dirname(args.checkpoint), { recursive: true });
const prior = await loadCheckpoint(args.checkpoint); const byKey = new Map(prior.map((row) => [row.key, row]));
console.log(`Benchmark: ${cases.length} cases / ${cases.reduce((sum, testCase) => sum + testCase.candidates.length, 0)} decisions per pass`);
console.log(`Loaded ${prior.length} checkpoint rows from ${args.checkpoint}`);

await callOllama(args, cases[0], 'temperature_0', 1);
let completed = 0; const wanted = args.variants.length * args.seeds.length * cases.length;
for (const seed of args.seeds) {
  for (const name of args.variants) {
    for (const testCase of cases) {
      const key = `${args.suite}|${args.model}|${name}|${seed}|${testCase.id}`;
      if (!byKey.has(key)) {
        const row = await callOllama(args, testCase, name, seed); byKey.set(key, row);
        await appendFile(args.checkpoint, `${JSON.stringify(row)}\n`);
      }
      completed += 1;
      if (completed % 25 === 0) console.log(`[${completed}/${wanted}] seed=${seed} variant=${name}`);
    }
  }
}

const selected = [...byKey.values()].filter((row) => row.model === args.model && args.variants.includes(row.variant) && args.seeds.includes(row.seed));
const results = args.variants.map((name) => {
  const rows = selected.filter((row) => row.variant === name);
  return { variant: name, note: VARIANTS[name].note, summary: score(rows), pairedVsBaseline: pairedBootstrap(selected, name), rows };
});
const output = { generatedAt: new Date().toISOString(), suite: args.suite, model: args.model, cases: cases.length, decisionsPerPass: cases.reduce((sum, item) => sum + item.candidates.length, 0), seeds: args.seeds, variants: Object.fromEntries(args.variants.map((name) => [name, VARIANTS[name]])), results: roundDeep(results) };
const outputPath = args.output ?? path.join(here, 'results', `sweep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.table(results.map((result) => ({ variant: result.variant, accuracy: rounded(result.summary.accuracy), keepRecall: rounded(result.summary.keepRecall), pruneRecall: rounded(result.summary.pruneRecall), falsePrunes: result.summary.falsePrunes, falseKeeps: result.summary.falseKeeps, medianMs: Math.round(result.summary.medianMs), parseFailures: result.summary.parseFailures })));
console.log(`Wrote ${outputPath}`);
