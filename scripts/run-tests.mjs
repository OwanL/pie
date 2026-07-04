#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const reporterSpecifier = pathToFileURL(path.join(__dirname, 'test-reporter.mjs')).href;
const npxCommand = 'npx';

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
    id: 'cwd-skills',
    cwd: repoRoot,
    testGlobs: ['extensions/cwd-skills/test/**/*.test.ts'],
    coverageIncludes: ['extensions/cwd-skills/**/*.ts'],
    thresholds: { lines: 95, branches: 95 },
  },
  {
    id: 'safeguard',
    cwd: repoRoot,
    testGlobs: ['extensions/safeguard/test/**/*.test.ts'],
    coverageIncludes: ['extensions/safeguard/**/*.ts'],
    thresholds: { lines: 85, branches: 80 },
  },
  {
    id: 'skill-pruner',
    cwd: repoRoot,
    testGlobs: ['extensions/skill-pruner/test/**/*.test.ts'],
    coverageIncludes: ['extensions/skill-pruner/**/*.ts'],
    thresholds: { lines: 91, branches: 79 },
  },
  {
    id: 'subagent',
    cwd: repoRoot,
    testGlobs: ['extensions/subagent/test/**/*.test.ts'],
    coverageIncludes: ['extensions/subagent/**/*.ts'],
    thresholds: { lines: 90, branches: 80 },
  },
  {
    id: 'ask-user',
    cwd: repoRoot,
    testGlobs: ['extensions/ask-user/test/**/*.test.ts'],
    coverageIncludes: ['extensions/ask-user/**/*.ts'],
    thresholds: { lines: 100, branches: 100 },
  },
  {
    id: 'warm-bash',
    cwd: repoRoot,
    testGlobs: ['extensions/warm-bash/test/**/*.test.ts'],
    coverageIncludes: ['extensions/warm-bash/**/*.ts'],
    // warm-pool tests spawn real bash and are environment-dependent; the
    // classifier (pure logic) carries the coverage backbone. Remaining branch
    // gaps are defensive empty catch blocks + the untestable cross-platform
    // (win32 vs unix) paths in kill.ts / warm-pool.ts.
    thresholds: { lines: 90, branches: 77 },
  },
  {
    id: 'web-access-compat',
    cwd: repoRoot,
    testGlobs: ['extensions/web-access-compat/test/**/*.test.ts'],
    coverageIncludes: ['extensions/web-access-compat/**/*.ts'],
    // env-glue (resolvePackageRoot / the factory wrapper) is not unit-testable
    // portably; the rewrite/patch/repair logic it delegates to is fully covered.
    thresholds: { lines: 82, branches: 78 },
  },
  {
    id: 'tool-result-pruner',
    cwd: repoRoot,
    testGlobs: ['extensions/tool-result-pruner/test/**/*.test.ts'],
    coverageIncludes: ['extensions/tool-result-pruner/**/*.ts'],
    // MVP: the lossless rules + pipeline guards are pure functions; the
    // index.ts factory is env-glue (registers a pi.on handler) and is not
    // unit-testable without the pi runtime. Types-global.d.ts is ambient only.
    thresholds: { lines: 92, branches: 80 },
  },
  {
    id: 'session-reviewer',
    cwd: repoRoot,
    testGlobs: ['extensions/session-reviewer/test/**/*.test.ts'],
    coverageIncludes: ['extensions/session-reviewer/**/*.ts'],
    // transcript.ts (the JSONL parser) is the unit-testable core; index.ts is
    // env-glue (registers the `session_review` tool) and store.ts is fs I/O,
    // neither of which is unit-testable without the pi runtime / a real disk.
    // types-global.d.ts is ambient only.
    thresholds: { lines: 80, branches: 70 },
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
  console.log(`Usage: npm run test -- [--package <id>] [--list]\n\n` +
    `Runs package tests in isolation with concise output and package-level coverage gates.\n\n` +
    `Options:\n` +
    `  --package <id>   Run only the selected package. Repeatable.\n` +
    `  --list           Print available package ids.\n` +
    `  --help           Show this help.\n`);
}

function printPackageList() {
  console.log('Available package ids:');
  for (const config of PACKAGE_CONFIGS) {
    const aliasSuffix = (config.aliases?.length ?? 0) > 0 ? ` (aliases: ${config.aliases.join(', ')})` : '';
    console.log(`- ${config.id}${aliasSuffix}`);
  }
}

function parseArgs(argv) {
  const selected = [];
  let listOnly = false;
  let helpOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      helpOnly = true;
      continue;
    }
    if (arg === '--list') {
      listOnly = true;
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { selected, listOnly, helpOnly };
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

function buildTestArgs(config) {
  return [
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--experimental-test-coverage',
    `--test-reporter=${reporterSpecifier}`,
    ...config.coverageIncludes.map((pattern) => `--test-coverage-include=${pattern}`),
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

function resolveCommandInvocation(command, args) {
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    const comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', [command, ...args].join(' ')],
    };
  }

  return { command, args };
}

function runChildProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const invocation = resolveCommandInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? 0, signal, stdout, stderr });
    });
  });
}

async function runPackage(config) {
  const args = buildTestArgs(config);
  const rawResult = await runChildProcess(npxCommand, args, config.cwd);
  const report = parseReporterOutput(rawResult.stdout, rawResult.stderr);
  const summary = report?.summary ?? null;
  const coverage = report?.coverage ?? null;
  const failures = report?.failures ?? [];
  const coverageFailures = summarizeCoverageFailures(config, coverage);

  const hasTestFailures = Boolean(summary && (!summary.success || (summary.counts?.failed ?? 0) > 0 || failures.length > 0));
  const hasInfrastructureFailure = !summary || rawResult.signal !== null || (rawResult.exitCode !== 0 && !hasTestFailures);
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

  const results = await Promise.all(selectedPackages.map((config) => runPackage(config)));
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
    return;
  }

  const failedPackageIds = failedResults.map((result) => result.config.id).join(', ');
  console.log(`Summary: ${passedCount}/${results.length} ${packageWord} passed — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped.`);
  console.log(`Failed packages: ${failedPackageIds}`);
  process.exitCode = 1;
}

await main();
