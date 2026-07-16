#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const benchmark = JSON.parse(await readFile(path.join(here, 'benchmark.json'), 'utf8'));
const productionPrompt = (await readFile(path.resolve(here, '../../../extensions/skill-pruner/pruning-system-prompt.md'), 'utf8'))
  .trim()
  .replace('{{STRATEGY_INSTRUCTION}}', 'Use the greater-than-50-percent probability boundary independently for every candidate. An empty keep list is correct when none is probably needed.');

const APPROACHES = {
  'production-keep-list': {
    description: 'Exact production flat keep-list system contract and production-style user payload.',
    system: productionPrompt,
  },
  'current-prune-json': {
    description: 'One catalog call; current keep-biased prune-list JSON contract.',
    system: [
      "You are a relevance curator for a coding agent's prompt-pruning prepass.",
      'Decide which skills and tools can be safely REMOVED for this request.',
      'Consider the full work arc: understand, explore, edit, validate, debug, and clean up.',
      'Interpret the latest request using recent conversation, but obey an explicit latest-message pivot.',
      'Default to KEEPING. Remove only an item unlikely to be used before the request is complete.',
      'Return only valid JSON in exactly this shape: {"pruneSkills":[],"pruneTools":[]}',
    ].join('\n'),
  },
  'catalog-keep-json': {
    description: 'One catalog call; positive keep-list JSON using the greater-than-50-percent rule.',
    system: [
      "Select the skills and tools a coding agent will probably invoke before completing the current request.",
      'A name belongs in the keep list when its probability of actual use is greater than 50 percent; omit it otherwise.',
      'Count implied work: implementation usually needs file reading, editing, and command/test execution; current external facts need web access; named specialist workflows need their matching skill.',
      'Recent context resolves references. The latest request overrides earlier work when it pivots or stops it.',
      'Return only valid JSON in exactly this shape: {"keepSkills":[],"keepTools":[]}',
      'Use only supplied names. Do not explain and do not wrap the JSON in markdown.',
    ].join('\n'),
  },
  'catalog-keep-list': {
    description: 'One catalog call; positive flat keep-list JSON with no skill/tool category confusion.',
    system: [
      "Select the candidate capabilities a coding agent will probably invoke before completing the current request.",
      'Keep a name when its probability of actual use is greater than 50 percent; omit it otherwise.',
      'Count implied work: implementation usually needs file reading, editing, and command/test execution; current external facts need web access; named specialist workflows need their matching skill.',
      'Recent context resolves references. The latest request overrides earlier work when it pivots or stops it.',
      'Return only valid JSON in exactly this shape: {"keep":[]}',
      'Use only supplied names. Do not explain and do not wrap the JSON in markdown.',
    ].join('\n'),
  },
  'catalog-keep-bits': {
    description: 'One catalog call; one aligned bit per candidate, where 1 means keep.',
    system: [
      'Classify each candidate independently for a coding agent.',
      'Output 1 when the candidate has a greater than 50% chance of being used before the current request is complete.',
      'Output 0 otherwise. Include implied exploration, editing, testing, debugging, and cleanup.',
      'Use recent context only to resolve references. The latest request wins when it changes or stops earlier work.',
      'Return exactly one 0/1 character per candidate in the given order, with no spaces or explanation.',
    ].join('\n'),
  },
  'catalog-prune-bits': {
    description: 'One catalog call; one aligned bit per candidate, where 1 means prune.',
    system: [
      'Classify each candidate independently for a coding agent.',
      'Output 1 when the candidate has at most a 50% chance of being used before the current request is complete, so it should be pruned.',
      'Output 0 when it is more likely than not to be used and must be kept.',
      'Include implied exploration, editing, testing, debugging, and cleanup.',
      'Use recent context only to resolve references. The latest request wins when it changes or stops earlier work.',
      'Return exactly one 0/1 character per candidate in the given order, with no spaces or explanation.',
    ].join('\n'),
  },
  'catalog-keep-bits-v2': {
    description: 'One catalog call; reinforced exact-length aligned bits, where 1 means keep.',
    system: [
      'Make a separate KEEP-or-PRUNE decision for EVERY numbered candidate.',
      'KEEP (1) when the capability is more likely than not to be invoked before the current request is complete. PRUNE (0) otherwise.',
      'Implementation normally needs code reading, editing, and command/test execution even when those steps are not named.',
      'Current external facts normally need web access. Named specialist workflows normally need the matching skill.',
      'Do not keep an unrelated specialist merely because it could be generally useful.',
      'Recent context resolves references such as "that". An explicit latest-message pivot overrides old work.',
      'Example: for 3 candidates whose decisions are KEEP, PRUNE, KEEP, output exactly 101.',
      'Never output one overall decision. Output one bit per candidate, in order, and nothing else.',
    ].join('\n'),
  },
  'catalog-keep-array': {
    description: 'One catalog call; a JSON array containing one 1=keep / 0=prune integer per candidate.',
    system: [
      'For every numbered candidate, estimate whether the coding agent will actually invoke it before completing the request.',
      'Use integer 1 when probability of use is greater than 50 percent. Use integer 0 otherwise.',
      'Count implied work: implementation usually uses file reading, editing, and command/test execution; current external facts use web access; named specialist workflows use their matching skill.',
      'Recent context resolves references. The latest request overrides earlier work when it pivots or stops it.',
      'Return only a valid JSON array with exactly one 0-or-1 integer per candidate in the same order. Do not explain.',
    ].join('\n'),
  },
  'item-keep-bit': {
    description: 'One independent call per candidate; a single 1 means keep and 0 means prune.',
    system: [
      'Decide whether one candidate capability will probably be used by a coding agent.',
      'Return 1 if its chance of use before the current request is complete is greater than 50%. Return 0 otherwise.',
      'Count implied exploration, editing, testing, debugging, and cleanup.',
      'Use recent context only to resolve references. The latest request wins when it changes or stops earlier work.',
      'Return exactly one character: 1 or 0.',
    ].join('\n'),
  },
  'item-keep-bit-v2': {
    description: 'One independent call per candidate; reinforced usage examples and 1 means keep.',
    system: [
      'Classify ONE candidate capability for a coding agent. Output exactly 1 for KEEP or 0 for PRUNE.',
      'KEEP when it is more likely than not that the agent will invoke this capability before completing the current request.',
      'Implementation normally invokes file reading, editing, and command/test execution even if unstated. Current external facts invoke web access. Named specialist workflows invoke the matching skill.',
      'PRUNE unrelated specialist capabilities. Recent context only resolves references; an explicit latest-message pivot wins.',
      'Judge actual likely invocation, not whether the capability sounds generally useful. Return one character only.',
    ].join('\n'),
  },
  'item-prune-bit-v2': {
    description: 'One independent call per candidate; fail-safe framing where 1 means prune.',
    system: [
      'Classify ONE candidate capability for a coding agent. Output exactly 1 for PRUNE or 0 for KEEP.',
      'PRUNE only when it is more likely than not that the agent will NOT invoke this capability before completing the current request.',
      'Implementation normally invokes file reading, editing, and command/test execution even if unstated. Current external facts invoke web access. Named specialist workflows invoke the matching skill.',
      'Recent context only resolves references; an explicit latest-message pivot wins. Do not keep an unrelated specialist merely because it could be generally useful.',
      'Judge actual likely invocation. Return one character only.',
    ].join('\n'),
  },
  'item-keep-bit-v3': {
    description: 'One independent call per candidate; minimal positive numeric question with brief implied-step guidance.',
    system: [
      'Will the coding agent probably invoke the candidate capability before completing the current request?',
      'Answer digit 1 for yes (probability greater than 50 percent) or digit 0 for no.',
      'Count implied steps. Implementation usually needs reading, editing, and command/test execution. Current external facts usually need web access. A named specialist workflow usually needs its matching skill.',
      'The latest request overrides earlier work if it pivots or stops it. Output one digit only.',
    ].join('\n'),
  },
  'item-label': {
    description: 'One independent call per candidate; natural binary KEEP/PRUNE labels.',
    system: [
      'Will the coding agent probably invoke this candidate before completing the current request?',
      'Reply KEEP when probability of actual use is greater than 50 percent. Otherwise reply PRUNE.',
      'Count implied work: implementation normally uses file reading, editing, and command/test execution; current external facts use web access; named specialist workflows use their matching skill.',
      'Recent context resolves references. An explicit latest-message pivot overrides old work.',
      'Reply with exactly one word: KEEP or PRUNE.',
    ].join('\n'),
  },
};

const CONTEXTS = new Set(['latest', 'user-history', 'dialogue', 'full-dialogue', 'dialogue-prior-decision']);

function parseArgs(argv) {
  const args = {
    models: ['qwen2.5:7b-instruct'],
    approaches: Object.keys(APPROACHES),
    contexts: ['dialogue'],
    endpoint: 'http://127.0.0.1:11434',
    itemConcurrency: 4,
    output: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--models') { args.models = value.split(',').filter(Boolean); i += 1; }
    else if (arg === '--approaches') { args.approaches = value.split(',').filter(Boolean); i += 1; }
    else if (arg === '--contexts') { args.contexts = value.split(',').filter(Boolean); i += 1; }
    else if (arg === '--endpoint') { args.endpoint = value.replace(/\/$/, ''); i += 1; }
    else if (arg === '--item-concurrency') { args.itemConcurrency = Number(value); i += 1; }
    else if (arg === '--output') { args.output = value; i += 1; }
    else if (arg === '--help') {
      console.log('Usage: node run.mjs [--models a,b] [--approaches a,b] [--contexts latest,user-history,dialogue,full-dialogue,dialogue-prior-decision] [--item-concurrency 4] [--output file.json]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const name of args.approaches) if (!APPROACHES[name]) throw new Error(`Unknown approach: ${name}`);
  for (const name of args.contexts) if (!CONTEXTS.has(name)) throw new Error(`Unknown context mode: ${name}`);
  if (!Number.isInteger(args.itemConcurrency) || args.itemConcurrency < 1) throw new Error('--item-concurrency must be a positive integer');
  return args;
}

function renderContext(testCase, mode) {
	if (mode === 'latest' || testCase.recent.length === 0) return `Current request:\n${testCase.request}`;
	const available = mode === 'full-dialogue' ? [...(testCase.older ?? []), ...testCase.recent] : testCase.recent;
	const recent = mode === 'user-history'
		? available.filter((message) => message.role === 'user')
		: available;
	if (recent.length === 0) return `Current request:\n${testCase.request}`;
	const lines = [
		'Recent conversation (oldest to newest):',
		...recent.map((message) => `${message.role.toUpperCase()}: ${message.text}`),
	];
	if (mode === 'dialogue-prior-decision' && testCase.previousKeep?.length) {
		lines.push('', `Previous prepass kept (weak historical evidence; re-evaluate): ${testCase.previousKeep.join(', ')}`);
	}
	lines.push('',
		'Current request:',
		testCase.request,
	);
	return lines.join('\n');
}

function renderCatalogUser(testCase, contextMode, jsonContract = false) {
  const lines = [renderContext(testCase, contextMode), ''];
  if (jsonContract) {
    lines.push('Skills:');
    for (const candidate of testCase.candidates.filter((item) => item.kind === 'skill')) {
      lines.push(`- ${candidate.name}: ${candidate.description}`);
    }
    lines.push('', 'Tools:');
    for (const candidate of testCase.candidates.filter((item) => item.kind === 'tool')) {
      lines.push(`- ${candidate.name}: ${candidate.description}`);
    }
  } else {
    lines.push(`Candidates (${testCase.candidates.length}, preserve this order):`);
    testCase.candidates.forEach((candidate, index) => {
      lines.push(`${index + 1}. [${candidate.kind}] ${candidate.name}: ${candidate.description}`);
    });
  }
  return lines.join('\n');
}

function renderProductionUser(testCase, contextMode) {
  const lines = [`User request: "${testCase.request}"`];
  const available = contextMode === 'full-dialogue' ? [...(testCase.older ?? []), ...testCase.recent] : testCase.recent;
  const recent = contextMode === 'latest' ? [] : contextMode === 'user-history'
    ? available.filter((message) => message.role === 'user')
    : available;
  if (recent.length > 0) {
    lines.push('', 'Recent conversation (use this to interpret follow-up requests):');
    for (const message of recent) lines.push(`- ${message.role}: ${message.text}`);
  }
  if (contextMode === 'dialogue-prior-decision' && testCase.previousKeep?.length) {
    lines.push('', `Previous prepass kept (weak historical evidence; re-evaluate): ${testCase.previousKeep.join(', ')}`);
  }
  lines.push('', 'Candidate skills:');
  for (const candidate of testCase.candidates.filter((item) => item.kind === 'skill')) {
    lines.push(`- ${candidate.name}: ${candidate.description}`);
  }
  lines.push('', 'Candidate tools:');
  for (const candidate of testCase.candidates.filter((item) => item.kind === 'tool')) {
    lines.push(`- ${candidate.name}: ${candidate.description}`);
  }
  return lines.join('\n');
}

function renderItemUser(testCase, contextMode, candidate) {
  return [
    renderContext(testCase, contextMode),
    '',
    `Candidate kind: ${candidate.kind}`,
    `Candidate name: ${candidate.name}`,
    `Candidate description: ${candidate.description}`,
  ].join('\n');
}

async function ollamaChat(endpoint, model, system, user, numPredict) {
  const started = performance.now();
  const response = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: '20m',
      think: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      options: { temperature: 0, seed: 42, num_predict: numPredict },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const wallMs = performance.now() - started;
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  const body = await response.json();
  return {
    text: body.message?.content ?? '',
    wallMs,
    providerMs: typeof body.total_duration === 'number' ? body.total_duration / 1e6 : null,
    loadMs: typeof body.load_duration === 'number' ? body.load_duration / 1e6 : null,
    promptTokens: body.prompt_eval_count ?? null,
    outputTokens: body.eval_count ?? null,
  };
}

function stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseCurrentJson(text, testCase) {
  const cleaned = stripFences(text);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { valid: false, keep: testCase.candidates.map(() => true) };
  try {
    const value = JSON.parse(match[0]);
    if (!Array.isArray(value.pruneSkills) || !Array.isArray(value.pruneTools)) {
      return { valid: false, keep: testCase.candidates.map(() => true) };
    }
    const prunedSkills = new Set(value.pruneSkills);
    const prunedTools = new Set(value.pruneTools);
    return {
      valid: true,
      keep: testCase.candidates.map((candidate) => !(candidate.kind === 'skill' ? prunedSkills : prunedTools).has(candidate.name)),
    };
  } catch {
    return { valid: false, keep: testCase.candidates.map(() => true) };
  }
}

function parseKeepJson(text, testCase) {
  const cleaned = stripFences(text);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { valid: false, keep: testCase.candidates.map(() => true) };
  try {
    const value = JSON.parse(match[0]);
    if (!Array.isArray(value.keepSkills) || !Array.isArray(value.keepTools)) {
      return { valid: false, keep: testCase.candidates.map(() => true) };
    }
    const keptSkills = new Set(value.keepSkills);
    const keptTools = new Set(value.keepTools);
    return {
      valid: true,
      keep: testCase.candidates.map((candidate) => (candidate.kind === 'skill' ? keptSkills : keptTools).has(candidate.name)),
    };
  } catch {
    return { valid: false, keep: testCase.candidates.map(() => true) };
  }
}

function parseKeepList(text, testCase) {
  const cleaned = stripFences(text);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { valid: false, keep: testCase.candidates.map(() => true) };
  try {
    const value = JSON.parse(match[0]);
    if (!Array.isArray(value.keep)) return { valid: false, keep: testCase.candidates.map(() => true) };
    const kept = new Set(value.keep);
    return { valid: true, keep: testCase.candidates.map((candidate) => kept.has(candidate.name)) };
  } catch {
    return { valid: false, keep: testCase.candidates.map(() => true) };
  }
}

function parseBits(text, count, oneMeansKeep) {
  const cleaned = stripFences(text).replace(/\s+/g, '');
  if (!new RegExp(`^[01]{${count}}$`).test(cleaned)) {
    return { valid: false, keep: Array(count).fill(true) };
  }
  return { valid: true, keep: [...cleaned].map((bit) => oneMeansKeep ? bit === '1' : bit === '0') };
}

function parseArray(text, count) {
  const cleaned = stripFences(text);
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return { valid: false, keep: Array(count).fill(true) };
  try {
    const values = JSON.parse(match[0]);
    if (!Array.isArray(values) || values.length !== count || values.some((value) => value !== 0 && value !== 1)) {
      return { valid: false, keep: Array(count).fill(true) };
    }
    return { valid: true, keep: values.map((value) => value === 1) };
  } catch {
    return { valid: false, keep: Array(count).fill(true) };
  }
}

function parseLabel(text) {
  const cleaned = stripFences(text).trim().toUpperCase();
  if (cleaned === 'KEEP') return { valid: true, keep: true };
  if (cleaned === 'PRUNE') return { valid: true, keep: false };
  return { valid: false, keep: true };
}

async function mapLimit(items, limit, fn) {
  const results = Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runTrial(args, model, approachName, contextMode, testCase) {
  const approach = APPROACHES[approachName];
  const trialStarted = performance.now();
  if (approachName.startsWith('item-')) {
    const calls = await mapLimit(testCase.candidates, args.itemConcurrency, async (candidate) => {
      const user = renderItemUser(testCase, contextMode, candidate);
      const call = await ollamaChat(args.endpoint, model, approach.system, user, 4);
      const parsed = approachName === 'item-label'
        ? parseLabel(call.text)
        : (() => {
            const bits = parseBits(call.text, 1, approachName.includes('keep-bit'));
            return { valid: bits.valid, keep: bits.keep[0] };
          })();
      return { candidate: candidate.name, user, ...call, valid: parsed.valid, keep: parsed.keep };
    });
    return {
      caseId: testCase.id,
      wallMs: performance.now() - trialStarted,
      callCount: calls.length,
      parseValid: calls.every((call) => call.valid),
      predictedKeep: calls.map((call) => call.keep),
      calls,
    };
  }

  const jsonContract = ['production-keep-list', 'current-prune-json', 'catalog-keep-json', 'catalog-keep-list'].includes(approachName);
  const user = approachName === 'production-keep-list'
    ? renderProductionUser(testCase, contextMode)
    : renderCatalogUser(testCase, contextMode, jsonContract);
  const call = await ollamaChat(args.endpoint, model, approach.system, user, jsonContract ? 160 : testCase.candidates.length + 8);
  const parsed = jsonContract
    ? approachName === 'catalog-keep-json'
      ? parseKeepJson(call.text, testCase)
      : approachName === 'catalog-keep-list' || approachName === 'production-keep-list'
        ? parseKeepList(call.text, testCase)
        : parseCurrentJson(call.text, testCase)
    : approachName === 'catalog-keep-array'
      ? parseArray(call.text, testCase.candidates.length)
      : parseBits(call.text, testCase.candidates.length, approachName.includes('keep-bits'));
  return {
    caseId: testCase.id,
    wallMs: performance.now() - trialStarted,
    callCount: 1,
    parseValid: parsed.valid,
    predictedKeep: parsed.keep,
    calls: [{ user, ...call, valid: parsed.valid }],
  };
}

function scoreTrials(trials) {
  let trueKeep = 0;
  let truePrune = 0;
  let falsePrune = 0;
  let falseKeep = 0;
  let correct = 0;
  let total = 0;
  let exactCases = 0;
  const callLatencies = [];
  for (const trial of trials) {
    const testCase = benchmark.cases.find((entry) => entry.id === trial.caseId);
    let exact = true;
    testCase.candidates.forEach((candidate, index) => {
      const predicted = trial.predictedKeep[index];
      total += 1;
      if (predicted === candidate.expectedKeep) correct += 1;
      else exact = false;
      if (candidate.expectedKeep && predicted) trueKeep += 1;
      else if (!candidate.expectedKeep && !predicted) truePrune += 1;
      else if (candidate.expectedKeep && !predicted) falsePrune += 1;
      else falseKeep += 1;
    });
    if (exact) exactCases += 1;
    for (const call of trial.calls) callLatencies.push(call.wallMs);
  }
  callLatencies.sort((a, b) => a - b);
  const percentile = (p) => callLatencies[Math.min(callLatencies.length - 1, Math.floor(callLatencies.length * p))] ?? 0;
  return {
    decisions: total,
    accuracy: correct / total,
    keepRecall: trueKeep / (trueKeep + falsePrune || 1),
    pruneRecall: truePrune / (truePrune + falseKeep || 1),
    falsePrunes: falsePrune,
    falseKeeps: falseKeep,
    exactCases,
    parseFailures: trials.filter((trial) => !trial.parseValid).length,
    totalWallMs: trials.reduce((sum, trial) => sum + trial.wallMs, 0),
    medianCaseWallMs: [...trials].sort((a, b) => a.wallMs - b.wallMs)[Math.floor(trials.length / 2)]?.wallMs ?? 0,
    medianCallMs: percentile(0.5),
    p95CallMs: percentile(0.95),
    calls: callLatencies.length,
    promptTokens: trials.flatMap((trial) => trial.calls).reduce((sum, call) => sum + (call.promptTokens ?? 0), 0),
    outputTokens: trials.flatMap((trial) => trial.calls).reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
  };
}

function roundSummary(summary) {
  const rounded = { ...summary };
  for (const key of ['accuracy', 'keepRecall', 'pruneRecall']) rounded[key] = Number(rounded[key].toFixed(4));
  for (const key of ['totalWallMs', 'medianCaseWallMs', 'medianCallMs', 'p95CallMs']) rounded[key] = Math.round(rounded[key]);
  return rounded;
}

const args = parseArgs(process.argv.slice(2));
const output = {
  generatedAt: new Date().toISOString(),
  benchmarkVersion: benchmark.version,
  decisionRule: benchmark.decisionRule,
  configuration: args,
  approaches: Object.fromEntries(args.approaches.map((name) => [name, APPROACHES[name]])),
  results: [],
};

for (const model of args.models) {
  process.stdout.write(`Warming ${model}...\n`);
  await ollamaChat(args.endpoint, model, 'Reply with one character.', 'Reply 1.', 2);
  for (const approach of args.approaches) {
    for (const contextMode of args.contexts) {
      process.stdout.write(`Running ${model} / ${approach} / ${contextMode}...\n`);
      const trials = [];
      for (const testCase of benchmark.cases) {
        trials.push(await runTrial(args, model, approach, contextMode, testCase));
      }
      const summary = roundSummary(scoreTrials(trials));
      output.results.push({ model, approach, contextMode, summary, trials });
      process.stdout.write(`  accuracy=${summary.accuracy} falsePrunes=${summary.falsePrunes} falseKeeps=${summary.falseKeeps} medianCase=${summary.medianCaseWallMs}ms parseFailures=${summary.parseFailures}\n`);
    }
  }
}

const defaultName = `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const outputPath = path.resolve(args.output ?? path.join(here, 'results', defaultName));
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`Wrote ${outputPath}\n`);
