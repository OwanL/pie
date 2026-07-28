#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from './lib/process-watchdog.mjs';
import { withoutGitRepositoryEnv } from './lib/git-environment.mjs';
import { resolveLocalTsx } from './run-test-files.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const reporterSpecifier = pathToFileURL(path.join(__dirname, 'test-reporter.mjs')).href;
const fastCachePath = path.join(repoRoot, '.cache', 'test-results', 'unit-suite.json');

const PACKAGE_CONFIGS = [
  {
    id: 'extension',
    cwd: path.join(repoRoot, 'extension'),
    testGlobs: ['./test/**/*.test.ts'],
    coverageIncludes: ['src/**/*.ts', 'src/**/*.tsx'],
    thresholds: { lines: 80, branches: 75 },
  },
  {
    id: 'analysis',
    aliases: ['analytics'],
    cwd: path.join(repoRoot, 'analysis'),
    testGlobs: ['./test/**/*.test.ts'],
    // The dashboard under site/ (app.ts + charts/) is a browser-rendered UI
    // layer — declarative Vega-Lite chart specs + DOM functions — not amenable
    // to the 95% unit gate without brittle spec assertions or jsdom. Its testable
    // pure functions (applyFilters, modelThinkingRows, compositionByModelRows)
    // are still exercised by the dashboard tests; only the logic/data layer
    // (scripts/) is unit-gated.
    coverageIncludes: ['scripts/**/*.ts'],
    thresholds: { lines: 95, branches: 78 },
  },
  {
    id: 'scripts',
    cwd: repoRoot,
    testGlobs: ['scripts/test/*.test.mjs'],
    // These tests exercise the test/typecheck runners and Git hooks themselves.
    // Keep their established no-coverage behavior: collecting coverage while
    // testing the coverage runner is both recursive in scope and misleading.
    coverage: false,
  },
  {
    id: 'cwd-skills',
    cwd: repoRoot,
    testGlobs: ['extensions/cwd-skills/test/**/*.test.ts'],
    coverageIncludes: ['extensions/cwd-skills/index.ts'],
    thresholds: { lines: 95, branches: 95 },
  },
  {
    id: 'safeguard',
    cwd: repoRoot,
    testGlobs: ['extensions/safeguard/test/**/*.test.ts'],
    coverageIncludes: ['extensions/safeguard/*.ts'],
    thresholds: { lines: 85, branches: 80 },
  },
  {
    id: 'skill-pruner',
    cwd: repoRoot,
    testGlobs: ['extensions/skill-pruner/test/**/*.test.ts'],
    coverageIncludes: ['extensions/skill-pruner/*.ts', 'extensions/skill-pruner/src/**/*.ts'],
    thresholds: { lines: 91, branches: 79 },
  },
  {
    id: 'subagent',
    cwd: repoRoot,
    testGlobs: ['extensions/subagent/test/**/*.test.ts'],
    coverageIncludes: ['extensions/subagent/*.ts', 'extensions/subagent/src/**/*.ts'],
    // Source-only coverage excludes the previously counted test files. Much of
    // runner.ts is real-SDK registration/session glue; keep its honest baseline
    // gated without restoring the inflated all-TypeScript metric.
    thresholds: { lines: 60, branches: 80 },
    // schema.ts imports runtime values (`StringEnum`, `Type`) from the pi
    // SDK's typebox via the legacy `@mariozechner/pi-ai` import. pi's loader
    // aliases that at runtime; plain tsx cannot resolve it (the SDK is nested
    // under pi-coding-agent's node_modules, never hoisted). This tsconfig's
    // `paths` alias those to the bundled copy so the schema test resolves a
    // single TypeBox instance. See extensions/subagent/tsconfig.json.
    tsxConfig: 'extensions/subagent/tsconfig.json',
  },
  {
    id: 'ask-user',
    cwd: repoRoot,
    testGlobs: ['extensions/ask-user/test/**/*.test.ts'],
    coverageIncludes: ['extensions/ask-user/index.ts', 'extensions/ask-user/src/**/*.ts'],
    thresholds: { lines: 100, branches: 100 },
  },
  {
    id: 'warm-bash',
    cwd: repoRoot,
    testGlobs: ['extensions/warm-bash/test/**/*.test.ts'],
    coverageIncludes: ['extensions/warm-bash/index.ts', 'extensions/warm-bash/src/**/*.ts'],
    // warm-pool tests spawn real bash and are environment-dependent; the
    // classifier (pure logic) carries the coverage backbone. Remaining branch
    // gaps are defensive empty catch blocks + the untestable cross-platform
    // (win32 vs unix) paths in kill.ts / warm-pool.ts.
    thresholds: { lines: 90, branches: 77 },
  },
  {
    id: 'copilot-model-discovery',
    cwd: repoRoot,
    testGlobs: ['extensions/copilot-model-discovery/test/**/*.test.ts'],
    coverageIncludes: ['extensions/copilot-model-discovery/src/**/*.ts'],
    thresholds: { lines: 90, branches: 80 },
  },
  {
    id: 'web-access-compat',
    cwd: repoRoot,
    testGlobs: ['extensions/web-access-compat/test/**/*.test.ts'],
    coverageIncludes: ['extensions/web-access-compat/*.ts'],
    // env-glue (resolvePackageRoot / the factory wrapper) is not unit-testable
    // portably; the rewrite/patch/repair logic it delegates to is fully covered.
    thresholds: { lines: 82, branches: 78 },
  },
  {
    id: 'tool-result-pruner',
    cwd: repoRoot,
    testGlobs: ['extensions/tool-result-pruner/test/**/*.test.ts'],
    coverageIncludes: ['extensions/tool-result-pruner/*.ts'],
    // MVP: the lossless rules + pipeline guards are pure functions; the
    // index.ts factory is env-glue (registers a pi.on handler) and is not
    // unit-testable without the pi runtime. Types-global.d.ts is ambient only.
    thresholds: { lines: 92, branches: 80 },
  },
  {
    id: 'session-reviewer',
    cwd: repoRoot,
    testGlobs: ['extensions/session-reviewer/test/**/*.test.ts'],
    coverageIncludes: ['extensions/session-reviewer/index.ts', 'extensions/session-reviewer/src/**/*.ts'],
    // transcript.ts (the JSONL parser) is the unit-testable core; index.ts is
    // env-glue (registers the `session_review` tool) and store.ts is fs I/O,
    // neither of which is unit-testable without the pi runtime / a real disk.
    // types-global.d.ts is ambient only.
    thresholds: { lines: 80, branches: 70 },
  },
  {
    id: 'session-changes',
    cwd: repoRoot,
    testGlobs: ['extensions/session-changes/test/**/*.test.ts'],
    coverageIncludes: ['extensions/session-changes/index.ts', 'extensions/session-changes/src/**/*.ts'],
    // session-jsonl.ts (the JSONL reader + toolCall↔toolResult join), render.ts
    // (TSV/minified-diff renderers), and diff.ts's pure minify/synthetic paths
    // are the unit-testable core; index.ts is env-glue (registers the
    // `session_changes` tool) and diff.ts's git exec is integration-only.
    // types-global.d.ts is ambient only. The shared derivation core + git-baseline
    // live in extension/src/shared/ and are covered by the extension suite.
    thresholds: { lines: 80, branches: 70 },
  },
  {
    id: 'deferred-triggers',
    cwd: repoRoot,
    testGlobs: ['extensions/deferred-triggers/test/**/*.test.ts'],
    coverageIncludes: ['extensions/deferred-triggers/index.ts', 'extensions/deferred-triggers/src/**/*.ts'],
    // store.ts (replay + sidecar I/O) is the unit-testable core; index.ts is
    // env-glue (registers the `defer_trigger` tool) and needs the pi runtime.
    // types-global.d.ts is ambient only.
    thresholds: { lines: 80, branches: 70 },
  },
  {
    id: 'computer-use',
    cwd: repoRoot,
    testGlobs: ['extensions/computer-use/test/**/*.test.ts'],
    coverageIncludes: [
      'extensions/computer-use/index.ts',
      'extensions/computer-use/src/**/*.ts',
      'extensions/computer-use/src/**/*.mjs',
    ],
    thresholds: { lines: 80, branches: 60 },
    tsxConfig: 'extensions/computer-use/tsconfig.json',
  },
  {
    id: 'image-context-guard',
    cwd: repoRoot,
    testGlobs: ['extensions/image-context-guard/test/**/*.test.ts'],
    coverageIncludes: [
      'extensions/image-context-guard/index.ts',
      'extensions/image-context-guard/src/**/*.ts',
    ],
    thresholds: { lines: 80, branches: 60 },
    tsxConfig: 'extensions/image-context-guard/tsconfig.json',
  },
];

const PACKAGE_LOOKUP = new Map();
for (const config of PACKAGE_CONFIGS) {
  PACKAGE_LOOKUP.set(config.id, config);
  for (const alias of config.aliases ?? []) {
    PACKAGE_LOOKUP.set(alias, config);
  }
}

function printHelp() {
  console.log(`Usage: npm run test -- [--package <id>] [--fast] [--integration] [--test-name-pattern <regex>] [-- <node:test args>]\n\n` +
    `Runs package tests in isolation with concise output and optional package-level coverage gates.\n\n` +
    `Options:\n` +
    `  --package <id>            Run only the selected package. Repeatable.\n` +
    `  --fast                    Developer loop: parallel test files, skip coverage collection/gates.\n` +
    `  --integration             Include slow real-SDK and real-shell integration tests.\n` +
    `  --test-name-pattern <re>  Forward a name filter to node:test.\n` +
    `  --list                    Print available package ids.\n` +
    `  --help                    Show this help.\n` +
    `  -- <args>                 Forward remaining arguments to node:test.\n\n` +
    `For specific files, prefer: npm run test:file -- <repo-relative-test-file>...\n`);
}

function printPackageList() {
  console.log('Available package ids:');
  for (const config of PACKAGE_CONFIGS) {
    const aliasSuffix = (config.aliases?.length ?? 0) > 0 ? ` (aliases: ${config.aliases.join(', ')})` : '';
    console.log(`- ${config.id}${aliasSuffix}`);
  }
}

export function parseArgs(argv) {
  const selected = [];
  const testArgs = [];
  let listOnly = false;
  let helpOnly = false;
  let fast = false;
  let integration = false;
  let forwarding = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (forwarding) {
      testArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      forwarding = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      helpOnly = true;
      continue;
    }
    if (arg === '--list') {
      listOnly = true;
      continue;
    }
    if (arg === '--fast') {
      fast = true;
      continue;
    }
    if (arg === '--integration') {
      integration = true;
      continue;
    }
    if (arg === '--package') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--package requires a value');
      }
      selected.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--package=')) {
      selected.push(arg.slice('--package='.length));
      continue;
    }
    if (arg === '--test-name-pattern') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--test-name-pattern requires a value');
      }
      testArgs.push(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--test-name-pattern=')) {
      testArgs.push(arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}. Use -- before additional node:test arguments.`);
  }

  return { selected, listOnly, helpOnly, fast, integration, testArgs };
}

function resolveSelectedPackages(selectedIds) {
  if (selectedIds.length === 0) {
    return PACKAGE_CONFIGS;
  }

  const resolved = [];
  const seen = new Set();
  for (const selectedId of selectedIds) {
    const config = PACKAGE_LOOKUP.get(selectedId);
    if (!config) {
      const available = PACKAGE_CONFIGS.map((entry) => entry.id).join(', ');
      throw new Error(`Unknown package id: ${selectedId}. Available: ${available}`);
    }
    if (seen.has(config.id)) {
      continue;
    }
    seen.add(config.id);
    resolved.push(config);
  }
  return resolved;
}

export function groupFastPackageConfigs(configs) {
  if (configs.length <= 1) {
    return configs;
  }

  const groups = new Map();
  for (const config of configs) {
    const key = `${config.cwd}\0${config.tsxConfig ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(config);
      existing.testGlobs.push(...config.testGlobs);
      continue;
    }
    groups.set(key, {
      ...config,
      members: [config],
      testGlobs: [...config.testGlobs],
      coverage: false,
    });
  }

  return [...groups.values()].map((group) => {
    const ids = group.members.map((member) => member.id);
    const isRootGroup = group.cwd === repoRoot && !group.tsxConfig;
    const fastConcurrency = group.id === 'extension' ? 8
      : group.id === 'analysis' ? 4
        : group.id === 'subagent' ? 2
          : isRootGroup ? 4
            : undefined;
    return {
      ...group,
      id: ids.length === 1 ? ids[0] : `${ids.length} root packages`,
      fastConcurrency,
    };
  });
}

function repoTestFingerprint() {
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'buffer', windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed while building the test-cache key`);
    }
    return result.stdout;
  };
  const hash = createHash('sha256');
  hash.update(process.version);
  hash.update(git('rev-parse', 'HEAD'));
  hash.update(git('diff', '--binary', 'HEAD'));
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
    .toString('utf8').split('\0').filter(Boolean).sort();
  for (const relativePath of untracked) {
    hash.update(relativePath);
    hash.update(readFileSync(path.join(repoRoot, relativePath)));
  }
  return hash.digest('hex');
}

async function readFastCache(fingerprint) {
  try {
    const cached = JSON.parse(await readFile(fastCachePath, 'utf8'));
    return cached.fingerprint === fingerprint ? cached : null;
  } catch {
    return null;
  }
}

async function writeFastCache(fingerprint, totals) {
  await mkdir(path.dirname(fastCachePath), { recursive: true });
  await writeFile(fastCachePath, JSON.stringify({ fingerprint, totals }), 'utf8');
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '0ms';
  }
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${Math.round(durationMs)}ms`;
}

function formatCoverage(coverage) {
  if (!coverage) {
    return 'coverage unavailable';
  }
  return `${formatPercent(coverage.coveredLinePercent)} lines / ${formatPercent(coverage.coveredBranchPercent)} branches`;
}

function formatCounts(counts) {
  if (!counts) {
    return 'no summary';
  }

  const parts = [
    `${counts.passed} passed`,
    `${counts.failed} failed`,
    `${counts.skipped} skipped`,
  ];
  if (counts.todo > 0) {
    parts.push(`${counts.todo} todo`);
  }
  if (counts.cancelled > 0) {
    parts.push(`${counts.cancelled} cancelled`);
  }
  return parts.join(', ');
}

function firstLine(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const line = value.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
  if (!line) {
    return null;
  }
  return line.replace(/\s+/gu, ' ').trim();
}

function formatFailureLocation(failure) {
  if (!failure.file) {
    return null;
  }

  return (path.relative(repoRoot, failure.file) || failure.file).replace(/\\/g, '/');
}

function formatFailureDetails(failure) {
  const lines = [`- ${failure.name}`];
  const location = formatFailureLocation(failure);
  if (location) {
    lines.push(`  at ${location}`);
  }
  const message = firstLine(failure.message);
  if (message) {
    lines.push(`  ${message}`);
  }
  return lines.join('\n');
}

function summarizeCoverageFailures(config, coverage) {
  if (config.coverage === false) {
    return [];
  }
  if (!coverage) {
    return ['coverage report missing'];
  }

  const failures = [];
  if (coverage.coveredLinePercent < config.thresholds.lines) {
    failures.push(`line coverage ${formatPercent(coverage.coveredLinePercent)} < ${config.thresholds.lines}%`);
  }
  if (coverage.coveredBranchPercent < config.thresholds.branches) {
    failures.push(`branch coverage ${formatPercent(coverage.coveredBranchPercent)} < ${config.thresholds.branches}%`);
  }
  return failures;
}

export function buildTestArgs(config, fast = false, testArgs = []) {
  // `--tsconfig` (when configured) tells tsx which tsconfig to use for module
  // resolution / path aliases. Only the subagent package sets this today: its
  // schema test needs the `paths` aliases in extensions/subagent/tsconfig.json
  // to resolve the pi SDK's nested typebox/pi-ai to a single instance. Must
  // precede the positional test globs.
  const tsxConfigArgs = config.tsxConfig ? [`--tsconfig=${config.tsxConfig}`] : [];
  const collectCoverage = !fast && config.coverage !== false;
  return [
    ...tsxConfigArgs,
    '--test',
    // Full verification is serialized for deterministic shared-env fixtures.
    // Fast mode lets node:test parallelize independent test files, which is
    // substantially quicker for the 2k+ extension suite.
    ...(fast
      ? (config.fastConcurrency ? [`--test-concurrency=${config.fastConcurrency}`] : [])
      : ['--test-concurrency=1']),
    ...(collectCoverage ? ['--experimental-test-coverage'] : []),
    `--test-reporter=${reporterSpecifier}`,
    ...(collectCoverage ? config.coverageIncludes.map((pattern) => `--test-coverage-include=${pattern}`) : []),
    ...testArgs,
    ...config.testGlobs,
  ];
}

function parseReporterOutput(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const summaryLine = combined
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(REPORT_PREFIX))
    .at(-1);

  if (!summaryLine) {
    return null;
  }

  return JSON.parse(summaryLine.slice(REPORT_PREFIX.length));
}

function stripReporterLines(output) {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith(REPORT_PREFIX))
    .join('\n');
}

function tailLines(text, maxLines = 40) {
  const lines = text.split(/\r?\n/u);
  return lines.slice(-maxLines).join('\n');
}

function indent(text, prefix = '  ') {
  return text
    .split(/\r?\n/u)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function runChildProcess(command, args, cwd, signal, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, withProcessTreeIsolation({
      cwd,
      env: { ...withoutGitRepositoryEnv(process.env), FORCE_COLOR: '0', ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));

    let stdout = '';
    let stderr = '';
    const timeoutMs = resolveChildProcessTimeoutMs();
    const watchdog = watchChildProcess(child, {
      timeoutMs,
      signal,
      label: `${path.basename(cwd)} tests`,
      onTerminate: ({ reason }) => {
        const detail = reason === 'timeout' ? ` after ${timeoutMs}ms` : '';
        stderr += `\nTest process ${reason === 'timeout' ? 'timed out' : 'was aborted'}${detail}; killed process tree.\n`;
      },
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', async (error) => {
      await watchdog.settle().catch(() => {});
      reject(error);
    });
    child.on('close', async (exitCode, closeSignal) => {
      const cleanup = await watchdog.settle().catch((error) => ({ gone: false, survivors: [], diagnostics: [String(error)] }));
      if (!cleanup.gone) stderr += `\nProcess-tree cleanup failed; surviving owned PIDs: ${cleanup.survivors.join(', ')}.\n`;
      resolve({
        exitCode: watchdog.timedOut || watchdog.aborted || !cleanup.gone ? 1 : (exitCode ?? 0),
        signal: closeSignal,
        stdout,
        stderr,
        timedOut: watchdog.timedOut,
        aborted: watchdog.aborted,
      });
    });
  });
}

async function runPackage(config, fast = false, integration = false, testArgs = [], signal) {
  const args = buildTestArgs(config, fast, testArgs);
  // Invoke the package-local tsx CLI directly rather than routing through npx
  // and a platform shell. This preserves regexes/spaces in forwarded node:test
  // arguments and avoids command-resolution differences between cwd/shells.
  const rawResult = await runChildProcess(
    process.execPath,
    [resolveLocalTsx(config.cwd), ...args],
    config.cwd,
    signal,
    integration ? { PIE_RUN_INTEGRATION_TESTS: '1' } : {},
  );
  const report = parseReporterOutput(rawResult.stdout, rawResult.stderr);
  const summary = report?.summary ?? null;
  const coverage = report?.coverage ?? null;
  const failures = report?.failures ?? [];
  const coverageFailures = fast ? [] : summarizeCoverageFailures(config, coverage);

  const hasTestFailures = Boolean(summary && (!summary.success || (summary.counts?.failed ?? 0) > 0 || failures.length > 0));
  const hasInfrastructureFailure = !summary || rawResult.signal !== null || rawResult.timedOut || rawResult.aborted || (rawResult.exitCode !== 0 && !hasTestFailures);
  const passed = !hasInfrastructureFailure && !hasTestFailures && coverageFailures.length === 0;

  return {
    config,
    rawResult,
    summary,
    coverage,
    failures,
    coverageFailures,
    passed,
    hasInfrastructureFailure,
  };
}

function printPackageResult(result) {
  const { config, summary, coverage, failures, coverageFailures, rawResult, passed, hasInfrastructureFailure } = result;
  const status = passed ? '✓' : '✖';
  const counts = summary?.counts ?? null;
  const durationMs = summary?.durationMs ?? 0;

  console.log(`${status} ${config.id} — ${formatCounts(counts)} — ${formatCoverage(coverage)} — ${formatDuration(durationMs)}`);

  if (failures.length > 0) {
    console.log(indent('failing tests:'));
    for (const failure of failures) {
      console.log(indent(formatFailureDetails(failure), '    '));
    }
  }

  if (coverageFailures.length > 0) {
    console.log(indent('coverage gates:'));
    for (const failure of coverageFailures) {
      console.log(indent(`- ${failure}`, '    '));
    }
  }

  if (hasInfrastructureFailure) {
    const rawOutput = stripReporterLines(`${rawResult.stdout}\n${rawResult.stderr}`);
    if (rawOutput.trim().length > 0) {
      console.log(indent('runner output:'));
      console.log(indent(tailLines(rawOutput), '    '));
    }
    if (!summary) {
      console.log(indent('- test summary missing; the test process did not finish cleanly', '    '));
    }
    if (rawResult.signal) {
      console.log(indent(`- terminated by signal ${rawResult.signal}`, '    '));
    }
    if (rawResult.timedOut) {
      console.log(indent('- test-process watchdog expired; full process tree was killed', '    '));
    } else if (rawResult.aborted) {
      console.log(indent('- runner was interrupted; full process tree was killed', '    '));
    }
  }
}

function aggregateCounts(results) {
  return results.reduce((totals, result) => {
    const counts = result.summary?.counts;
    if (!counts) {
      return totals;
    }
    totals.tests += counts.tests;
    totals.passed += counts.passed;
    totals.failed += counts.failed;
    totals.skipped += counts.skipped;
    totals.todo += counts.todo;
    totals.cancelled += counts.cancelled;
    return totals;
  }, {
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  });
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (parsedArgs.helpOnly) {
    printHelp();
    return;
  }

  if (parsedArgs.listOnly) {
    printPackageList();
    return;
  }

  let selectedPackages;
  try {
    selectedPackages = resolveSelectedPackages(parsedArgs.selected);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const cacheable = parsedArgs.fast
    && parsedArgs.selected.length === 0
    && !parsedArgs.integration
    && process.env.PIE_RUN_INTEGRATION_TESTS !== '1'
    && parsedArgs.testArgs.length === 0;
  let fingerprint;
  if (cacheable) {
    try {
      fingerprint = repoTestFingerprint();
      const cached = await readFastCache(fingerprint);
      if (cached) {
        const totals = cached.totals;
        console.log(`✓ cached repo-wide unit suite — ${totals.passed} passed, ${totals.skipped} skipped`);
        console.log('\nSummary: unchanged sources match the last successful unit run.');
        return;
      }
    } catch {
      // Cache failures must never prevent tests from running.
      fingerprint = undefined;
    }
  }

  // A separate node:test runner per package multiplies Node's default worker
  // count and badly oversubscribes the machine. Fast repo-wide runs combine
  // packages that share a cwd/tsx configuration, then divide file concurrency
  // across the four resulting runners.
  const executionConfigs = parsedArgs.fast ? groupFastPackageConfigs(selectedPackages) : selectedPackages;

  const processAbort = abortOnProcessSignals();
  let results;
  try {
    results = await Promise.all(executionConfigs.map((config) => runPackage(
      config,
      parsedArgs.fast,
      parsedArgs.integration,
      parsedArgs.testArgs,
      processAbort.signal,
    )));
  } finally {
    processAbort.dispose();
  }
  for (const result of results) {
    printPackageResult(result);
  }

  const totals = aggregateCounts(results);
  const failedResults = results.filter((result) => !result.passed);
  const passedCount = results.length - failedResults.length;
  const packageWord = results.length === 1 ? 'package' : 'packages';

  console.log('');
  if (failedResults.length === 0) {
    console.log(`Summary: ${passedCount}/${results.length} ${packageWord} passed — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped.`);
    if (fingerprint) {
      try {
        // Do not cache a pass if files changed while the suite was running.
        if (repoTestFingerprint() === fingerprint) {
          await writeFastCache(fingerprint, totals);
        }
      } catch {
        // A failed cache write does not change a successful test result.
      }
    }
    return;
  }

  const failedPackageIds = failedResults.map((result) => result.config.id).join(', ');
  console.log(`Summary: ${passedCount}/${results.length} ${packageWord} passed — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped.`);
  console.log(`Failed packages: ${failedPackageIds}`);
  process.exitCode = 1;
}

// Keep pure argument/command construction importable by focused script tests.
const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
