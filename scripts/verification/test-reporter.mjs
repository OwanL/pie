import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
export const TEST_FILE_MARKER = '__PI_TEST_FILE__:';
export const TEST_FILE_ACCOUNTING_ENV = 'PIE_TEST_FILE_ACCOUNTING_CONTEXT';

export function normalizeTestFileIdentity(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const resolved = path.resolve(value).replace(/\\/gu, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function accountTestFiles(enumeratedFiles, executedFiles, intentionalReruns = []) {
  const expected = new Map();
  const displayPaths = new Map();
  const enumeratedDuplicates = [];
  for (const file of enumeratedFiles) {
    const identity = normalizeTestFileIdentity(file);
    if (!identity) throw new TypeError('Enumerated test-file paths must be non-empty strings');
    if (expected.has(identity)) enumeratedDuplicates.push(displayPaths.get(identity));
    else {
      expected.set(identity, 1);
      displayPaths.set(identity, file);
    }
  }

  const rerunCounts = new Map();
  const orphanedReruns = [];
  for (const file of intentionalReruns) {
    const identity = normalizeTestFileIdentity(file);
    if (!identity) throw new TypeError('Intentional rerun paths must be non-empty strings');
    if (!expected.has(identity)) orphanedReruns.push(file);
    else expected.set(identity, expected.get(identity) + 1);
    rerunCounts.set(identity, (rerunCounts.get(identity) ?? 0) + 1);
  }

  const actual = new Map();
  for (const file of executedFiles) {
    const identity = normalizeTestFileIdentity(file);
    if (!identity) throw new TypeError('Executed test-file paths must be non-empty strings');
    actual.set(identity, (actual.get(identity) ?? 0) + 1);
    if (!displayPaths.has(identity)) displayPaths.set(identity, file);
  }

  const missing = [];
  const duplicates = [];
  const unexpected = [];
  const intentional = [];
  for (const [identity, count] of expected) {
    const file = displayPaths.get(identity);
    const executions = actual.get(identity) ?? 0;
    if (executions < count) missing.push({ file, expected: count, executed: executions });
    if (executions > count) duplicates.push({ file, expected: count, executed: executions });
    const allowedReruns = rerunCounts.get(identity) ?? 0;
    if (allowedReruns > 0) {
      intentional.push({ file, expected: allowedReruns, executed: Math.min(allowedReruns, Math.max(0, executions - 1)) });
    }
  }
  for (const [identity, executions] of actual) {
    if (!expected.has(identity)) unexpected.push({ file: displayPaths.get(identity), executed: executions });
  }

  return {
    success: enumeratedDuplicates.length === 0 && missing.length === 0 && duplicates.length === 0
      && unexpected.length === 0 && orphanedReruns.length === 0,
    enumerated: enumeratedFiles.length,
    executed: executedFiles.length,
    executedFiles,
    missing,
    duplicates,
    unexpected,
    enumeratedDuplicates,
    intentionalReruns: intentional,
    orphanedReruns,
  };
}

export function summarizeTestFileAccounting(accounting) {
  const { executedFiles, ...summary } = accounting;
  return summary;
}

export function readTestFileAccountingContext(env = process.env) {
  const contextPath = env[TEST_FILE_ACCOUNTING_ENV];
  if (!contextPath) return null;
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  if (!Array.isArray(context.expectedFiles) || !Array.isArray(context.intentionalReruns ?? [])) {
    throw new TypeError('Invalid test-file accounting context');
  }
  return context;
}

export function createTestFileExecutionCollector(context) {
  if (!context) return null;
  const executedFiles = [];
  const directFiles = new Map(Object.entries(context.directFiles ?? {})
    .map(([inputPath, sourceFile]) => [normalizeTestFileIdentity(inputPath), sourceFile]));
  const ignoredFiles = new Set((context.ignoredFiles ?? []).map(normalizeTestFileIdentity));
  return {
    observe(event) {
      if (event.type === 'test:start' && typeof event.data?.name === 'string'
        && event.data.name.startsWith(TEST_FILE_MARKER)) {
        executedFiles.push(event.data.name.slice(TEST_FILE_MARKER.length));
      } else if (event.type === 'test:complete' && event.data?.nesting === 0
        && typeof event.data?.file === 'string'
        && normalizeTestFileIdentity(event.data.name) === normalizeTestFileIdentity(event.data.file)) {
        // Node's harness completes one top-level test named after each input
        // file, even when its tests fail. Per-file summaries are not guaranteed
        // by every runner; nested tests/suites must not count as file runs.
        const identity = normalizeTestFileIdentity(event.data.file);
        const sourceFile = directFiles.get(identity);
        if (sourceFile) executedFiles.push(sourceFile);
        else if (!ignoredFiles.has(identity)) executedFiles.push(event.data.file);
      }
    },
    report() {
      return accountTestFiles(context.expectedFiles, executedFiles, context.intentionalReruns ?? []);
    },
  };
}

function normalizeSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const counts = summary.counts && typeof summary.counts === 'object'
    ? {
        tests: Number(summary.counts.tests ?? 0),
        failed: Number(summary.counts.failed ?? 0),
        passed: Number(summary.counts.passed ?? 0),
        cancelled: Number(summary.counts.cancelled ?? 0),
        skipped: Number(summary.counts.skipped ?? 0),
        todo: Number(summary.counts.todo ?? 0),
        topLevel: Number(summary.counts.topLevel ?? 0),
        suites: Number(summary.counts.suites ?? 0),
      }
    : null;

  return {
    success: Boolean(summary.success),
    counts,
    durationMs: Number(summary.duration_ms ?? 0),
  };
}

function aggregateFileSummaries(fileSummaries) {
  if (fileSummaries.length === 0) {
    return null;
  }

  const counts = {
    tests: 0,
    failed: 0,
    passed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    topLevel: 0,
    suites: 0,
  };

  let durationMs = 0;
  for (const summary of fileSummaries) {
    const normalized = normalizeSummary(summary);
    if (!normalized?.counts) {
      continue;
    }
    counts.tests += normalized.counts.tests;
    counts.failed += normalized.counts.failed;
    counts.passed += normalized.counts.passed;
    counts.cancelled += normalized.counts.cancelled;
    counts.skipped += normalized.counts.skipped;
    counts.todo += normalized.counts.todo;
    counts.topLevel += normalized.counts.topLevel;
    counts.suites += normalized.counts.suites;
    durationMs += normalized.durationMs;
  }

  return {
    success: counts.failed === 0 && counts.cancelled === 0,
    counts,
    durationMs,
  };
}

export function normalizeCoverage(coverageSummary) {
  const totals = coverageSummary?.totals;
  if (!totals || typeof totals !== 'object') {
    return null;
  }

  // Node's experimental coverage event can contain duplicate source-map line
  // records when TSX/jiti evaluate one source through multiple transforms. Its
  // built-in spec reporter unions those records by source line, while the raw
  // totals can undercount covered lines based on arrival order. Recompute only
  // line coverage from the file records; branch/function totals do not have the
  // same line-identity semantics and remain authoritative from Node.
  const byPath = new Map();
  for (const file of Array.isArray(coverageSummary.files) ? coverageSummary.files : []) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !Array.isArray(file.lines)) continue;
    let byLine = byPath.get(file.path);
    if (!byLine) { byLine = new Map(); byPath.set(file.path, byLine); }
    for (const entry of file.lines) {
      const line = Number(entry?.line);
      const count = Number(entry?.count ?? 0);
      if (!Number.isInteger(line) || line < 1) continue;
      byLine.set(line, Math.max(byLine.get(line) ?? 0, Number.isFinite(count) ? count : 0));
    }
  }
  let totalLineCount = 0;
  let coveredLineCount = 0;
  for (const lines of byPath.values()) {
    totalLineCount += lines.size;
    coveredLineCount += [...lines.values()].filter((count) => count > 0).length;
  }
  if (totalLineCount === 0) {
    totalLineCount = Number(totals.totalLineCount ?? 0);
    coveredLineCount = Number(totals.coveredLineCount ?? 0);
  }

  return {
    totalLineCount,
    totalBranchCount: Number(totals.totalBranchCount ?? 0),
    totalFunctionCount: Number(totals.totalFunctionCount ?? 0),
    coveredLineCount,
    coveredBranchCount: Number(totals.coveredBranchCount ?? 0),
    coveredFunctionCount: Number(totals.coveredFunctionCount ?? 0),
    coveredLinePercent: totalLineCount === 0 ? Number(totals.coveredLinePercent ?? 0) : (coveredLineCount / totalLineCount) * 100,
    coveredBranchPercent: Number(totals.coveredBranchPercent ?? 0),
    coveredFunctionPercent: Number(totals.coveredFunctionPercent ?? 0),
  };
}

function resolveFailureMessage(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const cause = error.cause;
  if (cause && typeof cause === 'object' && typeof cause.message === 'string' && cause.message.trim().length > 0) {
    return cause.message.trim();
  }

  if (typeof cause === 'string' && cause.trim().length > 0 && cause !== 'test failed') {
    return cause.trim();
  }

  if (typeof error.message === 'string' && error.message.trim().length > 0 && error.message !== 'test failed') {
    return error.message.trim();
  }

  if (typeof error.code === 'string' && error.code.length > 0) {
    return error.code;
  }

  return null;
}

function normalizeFailure(data) {
  const details = data?.details && typeof data.details === 'object' ? data.details : {};
  const error = details.error && typeof details.error === 'object' ? details.error : null;

  return {
    name: typeof data?.name === 'string' ? data.name : '(unnamed test)',
    file: typeof data?.file === 'string' ? data.file : null,
    line: Number.isInteger(data?.line) ? data.line : null,
    column: Number.isInteger(data?.column) ? data.column : null,
    durationMs: Number(details.duration_ms ?? 0),
    failureType: typeof error?.failureType === 'string' ? error.failureType : null,
    code: typeof error?.code === 'string' ? error.code : null,
    message: resolveFailureMessage(error),
  };
}

function normalizePathForComparison(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/').toLowerCase() : '';
}

function isWrapperFailure(failure) {
  const file = normalizePathForComparison(failure.file);
  const name = normalizePathForComparison(failure.name);
  if (!file || !name) {
    return false;
  }

  if (name === file) {
    return true;
  }

  const basename = path.posix.basename(file);
  return name === basename || name.endsWith(`/${basename}`);
}

function dedupeFailures(failures) {
  const seen = new Set();
  const deduped = [];
  for (const failure of failures) {
    const key = [failure.name, failure.file ?? '', failure.line ?? '', failure.column ?? ''].join('::');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(failure);
  }
  return deduped;
}

function finalizeFailures(failures) {
  const deduped = dedupeFailures(failures);
  const hasSpecificFailure = deduped.some((failure) => !isWrapperFailure(failure));
  return hasSpecificFailure ? deduped.filter((failure) => !isWrapperFailure(failure)) : deduped;
}

export default async function* reporter(source) {
  const failures = [];
  const fileSummaries = [];
  const fileCollector = createTestFileExecutionCollector(readTestFileAccountingContext());
  let globalSummary = null;
  let coverage = null;

  for await (const event of source) {
    fileCollector?.observe(event);
    switch (event.type) {
      case 'test:fail':
        failures.push(normalizeFailure(event.data));
        break;
      case 'test:summary':
        if (event.data?.file === undefined) {
          globalSummary = normalizeSummary(event.data);
        } else {
          fileSummaries.push(event.data);
        }
        break;
      case 'test:coverage':
        coverage = normalizeCoverage(event.data?.summary);
        break;
      default:
        break;
    }
  }

  const summary = globalSummary ?? aggregateFileSummaries(fileSummaries);
  const fileAccounting = fileCollector?.report() ?? null;
  if (fileAccounting && !fileAccounting.success) {
    if (summary) summary.success = false;
    failures.push({
      name: 'test-file accounting mismatch',
      file: null,
      line: null,
      column: null,
      durationMs: 0,
      failureType: null,
      code: null,
      message: JSON.stringify(summarizeTestFileAccounting(fileAccounting)),
    });
  }
  const report = {
    summary,
    coverage,
    failures: finalizeFailures(failures),
    ...(fileAccounting ? { fileAccounting } : {}),
  };

  yield `${REPORT_PREFIX}${JSON.stringify(report)}\n`;
}
