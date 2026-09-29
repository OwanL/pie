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
} from '../lib/process-watchdog.mjs';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { createTsconfigOverlay, resolveOwnerTsx } from '../lib/package-resolution.mjs';
import { PACKAGE_REGISTRY, ROOT_BATCH_PACKAGE_IDS } from '../lib/test-packages.mjs';
import { resolveLocalTsx } from './run-test-files.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const reporterSpecifier = pathToFileURL(path.join(__dirname, 'test-reporter.mjs')).href;
const fastCachePath = path.join(repoRoot, '.cache', 'test-results', 'unit-suite.json');

// Package identity, ordering, aliases, test cwd, tsx/tsc compiler selection,
// batching, and fast concurrency live in scripts/lib/test-packages.mjs
// (PACKAGE_REGISTRY). Only per-package test/coverage metadata is local here;
// scripts/verification/test/package-registry-drift.test.mjs fails when the two diverge.
const PACKAGE_TEST_METADATA = {
  extension: {
    testGlobs: [
      '../../../harness/agent-instructions/prompt-assembly/test/**/*.test.ts',
      '../../../test/integration/backend-runtime-prefs.test.ts',
      '../../../test/integration/capability-seam.test.ts',
      '../../../test/integration/protocol-envelope-contract.test.ts',
      '../../../test/integration/chat-message-parts.test.ts',
      '../../../test/integration/runtime-trace-bridge.test.ts',
      '../../../test/integration/tool-result-format.test.ts',
      '../../../test/integration/pie-harness-prompt.test.ts',
      '../../../test/integration/system-prompt-provider-payload.test.ts',
      '../../../test/integration/perf/auto-follow-reflow.test.ts',
      '../../../test/integration/perf/webview-render-count.test.ts',
      '../../../test/integration/worker-detail-webview-seam.test.ts',
      '../../frontend/**/*.test.ts',
      '../../frontend/**/*.test.tsx',
      '../../lib/protocol/test/**/*.test.ts',
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'test/**/*.test.mjs',
      '../**/*.test.ts',
      '../**/*.test.tsx',
      '../**/*.test.mjs',
    ],
    coverageIncludes: [
      '../../frontend/**/*.ts',
      '../../frontend/**/*.tsx',
      '**/*.ts',
      '**/*.tsx',
      '../**/*.ts',
      '../**/*.tsx',
      '../../../harness/session-storage/lifecycle/session-filesystem-lifecycle.ts',
      '../../../harness/session-storage/metadata/session-name.ts',
      '../../../harness/session-storage/ownership/session-identity.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
    fastRunner: path.join(repoRoot, 'scripts', 'verification', 'run-fast-extension-tests.mjs'),
  },
  analysis: {
    testGlobs: ['./test/**/*.test.ts'],
    // The dashboard under site/ (app.ts + charts/) is a browser-rendered UI
    // layer — declarative Vega-Lite chart specs + DOM functions — not amenable
    // to the 95% unit gate without brittle spec assertions or jsdom. Its testable
    // pure functions (applyFilters, modelThinkingRows, compositionByModelRows)
    // are still exercised by the dashboard tests; only the logic/data layer
    // (scripts/) is unit-gated.
    coverageIncludes: ['scripts/**/*.ts'],
    thresholds: { lines: 95, branches: 78 },
    // The retained analysis workspace is owned at analytics/analysis; test and
    // coverage globs are relative to that package's testCwd.
  },
  scripts: {
    testGlobs: [
      'scripts/test/*.test.mjs',
      'scripts/build/test/**/*.test.mjs',
      'scripts/build/test/**/*.test.ts',
      'scripts/diagnostics/test/**/*.test.mjs',
      'scripts/install/test/**/*.test.mjs',
      'scripts/lib/test/**/*.test.mjs',
      'scripts/migrations/test/**/*.test.mjs',
      'scripts/model-config/test/**/*.test.ts',
      'scripts/verification/test/**/*.test.mjs',
    ],
    // These tests exercise the test/typecheck runners, migration/install, and
    // diagnostics tooling. Keep their established no-coverage behavior:
    // collecting coverage while testing these tools is misleading.
    coverage: false,
  },
  lib: {
    testGlobs: [
      'lib/data-root/test/**/*.test.ts',
      'lib/sensitive-data/test/**/*.test.ts',
      'lib/structured-logging/test/**/*.test.ts',
      'lib/temporary-files/test/**/*.test.ts',
      'lib/transcript/test/**/*.test.ts',
      'lib/test/**/*.test.ts',
    ],
    coverageIncludes: [
      'lib/data-root/pie-data-root-core.mjs',
      'lib/data-root/pie-data-root.ts',
      'lib/json-structural-patch.ts',
      'lib/sensitive-data/sensitive-redaction.ts',
      'lib/structured-logging/backend-log.ts',
      'lib/structured-logging/error-message.ts',
      'lib/structured-logging/live-pipeline-trace-store.ts',
      'lib/structured-logging/live-pipeline-trace.ts',
      'lib/structured-logging/pie-logger.ts',
      'lib/temporary-files/atomic-write.ts',
      'lib/temporary-files/fs-retry.ts',
      'lib/temporary-files/temp-log-reaper.ts',
      'lib/transcript/turn-latency.ts',
      'lib/uuid.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
  },
  'cwd-skills': {
    testGlobs: [
      'harness/agent-instructions/skill-discovery/test/**/*.test.ts',
      'harness/agent-instructions/skill-discovery/test/**/*.test.mjs',
    ],
    coverageIncludes: ['harness/agent-instructions/skill-discovery/index.ts'],
    thresholds: { lines: 95, branches: 95 },
  },
  safeguard: {
    testGlobs: ['harness/tools/execution-safety/test/**/*.test.ts'],
    coverageIncludes: ['extensions/safeguard/index.ts', 'harness/tools/execution-safety/*.ts'],
    thresholds: { lines: 85, branches: 80 },
  },
  'skill-pruner': {
    testGlobs: [
      'harness/tool-and-skill-selection/**/*.test.ts',
      'extensions/skill-pruner/test/**/*.test.ts',
      'test/integration/dynamic-tool-activation.test.ts',
    ],
    coverageIncludes: [
      'harness/tool-and-skill-selection/settings/*.ts',
      'harness/tool-and-skill-selection/prepass/*.ts',
      'harness/tool-and-skill-selection/state/*.ts',
      'harness/tool-and-skill-selection/lifecycle/*.ts',
      'harness/tool-and-skill-selection/recovery/*.ts',
      'extensions/skill-pruner/index.ts',
      'harness/tool-and-skill-selection/lifecycle/pruning-lifecycle.ts',
      'harness/agent-instructions/skill-selection/skill-policy.ts',
      'harness/tools/selection/tool-policy.ts',
      'harness/tools/request-capability/index.ts',
    ],
    // Coverage is collected from ONE test process (--experimental-test-isolation=none).
    // node's per-child coverage merge corrupts cross-child unions for this
    // package (identical test files produced nondeterministic 73.5%–95.5% line
    // aggregates; per-file unions also silently DROPPED real coverage, e.g.
    // prepass.ts 88.9% -> 58.2%). A single serialized process — the package's
    // non-fast mode was already serialized for shared-env fixtures — yields an
    // accurate, deterministic per-file report. The package's tests require()
    // their subjects (see integration.test.ts) so the process holds exactly one
    // module instance per source file.
    singleProcessCoverage: true,
    thresholds: { lines: 91, branches: 79 },
  },
  'model-provider-authentication': {
    testGlobs: ['harness/model-providers/authentication/test/**/*.test.ts'],
    coverageIncludes: ['harness/model-providers/authentication/copilot-headers.ts'],
    thresholds: { lines: 90, branches: 90 },
  },
  'model-provider-concurrency': {
    testGlobs: ['harness/model-providers/concurrency/test/**/*.test.ts'],
    coverageIncludes: [
      'harness/model-providers/concurrency/coordinator-provider-network-lease.ts',
      'harness/model-providers/concurrency/provider-capacity-bridge.ts',
      'harness/model-providers/concurrency/provider-gate.ts',
    ],
    thresholds: { lines: 80, branches: 70 },
  },
  'model-provider-pricing': {
    testGlobs: ['harness/model-providers/pricing/test/**/*.test.ts'],
    coverageIncludes: [
      'harness/model-providers/pricing/pricing-core.ts',
      'harness/model-providers/pricing/pricing.ts',
      'harness/model-providers/pricing/provider-cost.ts',
      'harness/model-providers/pricing/subagent-settlement-pricing.ts',
    ],
    thresholds: { lines: 80, branches: 70 },
  },
  'model-provider-traffic-observation': {
    testGlobs: ['harness/model-providers/traffic-observation/test/**/*.test.ts'],
    coverageIncludes: ['harness/model-providers/traffic-observation/provider-incident.ts'],
    thresholds: { lines: 90, branches: 55 },
  },
  'agent-processes-coordinator': {
    testGlobs: [
      'harness/agent-processes/coordinator/test/**/*.test.ts',
      'test/integration/backend-expected-cancellation-log.test.ts',
      'test/integration/backend-diagnostics-trace.test.ts',
      'test/integration/backend-analytics-activation.test.ts',
      'test/integration/backend-session-worker-liveness.test.ts',
      'test/integration/worker-runtime-analytics-router.test.ts',
    ],
    coverageIncludes: ['harness/model-providers/retry-and-failover/subagent-provider-policy.ts'],
    thresholds: { lines: 90, branches: 85 },
  },
  'agent-processes-context-inventory': {
    testGlobs: ['harness/agent-processes/context-inventory/test/**/*.test.ts'],
    coverage: false,
  },
  'agent-processes-process-lifecycle': {
    testGlobs: ['harness/agent-processes/lib/process-lifecycle/test/**/*.test.ts'],
    coverage: false,
  },
  'agent-processes-rpc': {
    testGlobs: ['harness/agent-processes/lib/rpc/test/**/*.test.ts'],
    coverage: false,
  },
  'session-control': {
    testGlobs: ['harness/tools/session-control/test/**/*.test.ts'],
    coverage: false,
  },
  'tool-catalog': {
    testGlobs: ['test/integration/tool-catalog.test.ts'],
    coverageIncludes: ['harness/tools/catalog/*.ts'],
    thresholds: { lines: 90, branches: 80 },
  },
  subagent: {
    testGlobs: [
      'harness/tools/subagent/test/**/*.test.ts',
      'harness/agent-instructions/agent-discovery/test/**/*.test.ts',
    ],
    coverageIncludes: ['harness/tools/subagent/*.ts'],
    // Source-only coverage excludes the previously counted test files. Much of
    // runner.ts is real-SDK registration/session glue; keep its honest baseline
    // gated without restoring the inflated all-TypeScript metric.
    thresholds: { lines: 60, branches: 80 },
    // schema.ts imports runtime values (`StringEnum`, `Type`) from the pi
    // SDK's typebox via the legacy `@mariozechner/pi-ai` import. pi's loader
    // aliases that at runtime; plain tsx cannot resolve it (the SDK is nested
    // under pi-coding-agent's node_modules, never hoisted). This tsconfig's
    // `paths` alias those to the bundled copy so the schema test resolves a
    // single TypeBox instance. See harness/tools/subagent/tsconfig.json.
  },
  'ask-user': {
    testGlobs: ['harness/tools/ask-user/test/**/*.test.ts'],
    coverageIncludes: ['harness/tools/ask-user/*.ts'],
    thresholds: { lines: 100, branches: 100 },
  },
  'warm-bash': {
    testGlobs: ['harness/tools/warm-bash/test/**/*.test.ts'],
    coverageIncludes: ['harness/tools/warm-bash/index.ts', 'harness/tools/warm-bash/*.ts'],
    // warm-pool tests spawn real bash and are environment-dependent; the
    // classifier (pure logic) carries the coverage backbone. Remaining branch
    // gaps are defensive empty catch blocks + the untestable cross-platform
    // (win32 vs unix) paths in kill.ts / warm-pool.ts.
    thresholds: { lines: 90, branches: 77 },
  },
  'copilot-model-discovery': {
    testGlobs: ['harness/model-providers/model-discovery/test/**/*.test.ts'],
    coverageIncludes: [
      'harness/model-providers/model-discovery/catalog-lock.ts',
      'harness/model-providers/model-discovery/catalog-refresh.ts',
      'harness/model-providers/model-discovery/catalog-sync.ts',
      'harness/model-providers/model-discovery/catalog-ttl.ts',
      'harness/model-providers/model-discovery/copilot-models.ts',
    ],
    thresholds: { lines: 90, branches: 80 },
  },
  'model-provider-catalog': {
    testGlobs: [
      'harness/model-providers/catalog/test/**/*.test.ts',
      'test/integration/backend-model-profiles.test.ts',
    ],
    coverageIncludes: [
      'harness/model-providers/catalog/model-catalog.ts',
      'harness/model-providers/catalog/model-id.ts',
      'harness/model-providers/catalog/thinking-level.ts',
      'harness/model-providers/pricing/model-id.ts',
    ],
    thresholds: { lines: 85, branches: 80 },
  },
  'session-storage-transcripts': {
    testGlobs: [
      'harness/session-storage/transcripts/test/**/*.test.ts',
      'test/integration/backend-cold-session-browse.test.ts',
      'test/integration/real-sdk-image-persistence.test.ts',
      'test/integration/sdk-terminal-durability.test.ts',
    ],
    coverageIncludes: [
      'harness/session-storage/transcripts/*.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
  },
  'session-storage-lifecycle': {
    testGlobs: ['harness/session-storage/lifecycle/test/**/*.test.ts'],
    coverageIncludes: [
      'harness/session-storage/lifecycle/cold-session-store.ts',
      'harness/session-storage/lifecycle/legacy-review-artifact-cleanup.ts',
      'harness/session-storage/lifecycle/private-session-artifacts.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
  },
  'session-storage-catalog': {
    testGlobs: [
      'harness/session-storage/catalog/test/**/*.test.ts',
      'test/integration/backend-session-directory.test.ts',
    ],
    coverageIncludes: [
      'harness/session-storage/catalog/*.ts',
      'harness/session-storage/metadata/session-metadata.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
  },
  'session-storage-ownership': {
    testGlobs: [
      'harness/session-storage/ownership/test/**/*.test.ts',
      'test/integration/session-runtime-crash-matrix.test.ts',
    ],
    coverageIncludes: [
      'harness/session-storage/ownership/session-manager-fence.ts',
      'harness/session-storage/ownership/session-ownership-authority.ts',
      'harness/session-storage/ownership/write-ownership-trace.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
  },
  'session-storage-metadata': {
    testGlobs: ['harness/session-storage/metadata/test/**/*.test.ts'],
    coverageIncludes: [
      'harness/session-storage/metadata/session-name.ts',
      'harness/session-storage/metadata/session-provenance.ts',
    ],
    thresholds: { lines: 90, branches: 80 },
  },
  'analytics-runtime': {
    testGlobs: [
      'analytics/test/**/*.test.ts',
      'analytics/authority/test/**/*.test.ts',
      'analytics/contracts/test/**/*.test.ts',
      'analytics/capture/tool-call-analysis/test/**/*.test.ts',
      'application/backend/test/composition/**/*.test.ts',
      'application/backend/test/analytics-views/**/*.test.ts',
      'application/backend/analytics-views/test/**/*.test.ts',
    ],
    // No separate gate yet: the baseline ran these suites inside the extension
    // package's coverage denominator. Revisit when the legacy accounting batch
    // settles analytics coverage ownership (B6).
    coverage: false,
  },
  // B7: application backend owners. Coverage gates are intentionally not set
  // yet: these suites previously contributed to the extension package's
  // denominator and no per-owner baseline has been measured (recorded as an
  // open B7 item).
  'conversation-state': {
    testGlobs: [
      'application/backend/test/conversation-state/**/*.test.ts',
      'application/backend/conversation-state/test/**/*.test.ts',
      'test/integration/sync-contract.test.ts',
    ],
    coverage: false,
  },
  'session-actions': {
    testGlobs: ['application/backend/test/session-actions/**/*.test.ts'],
    coverage: false,
  },
  'agent-connection': {
    testGlobs: ['application/backend/test/agent-connection/**/*.test.ts', 'application/backend/agent-connection/test/**/*.test.ts'],
    coverage: false,
  },
  'deferred-triggers-backend': {
    testGlobs: ['application/backend/test/deferred-triggers/**/*.test.ts'],
    coverage: false,
  },
  'application-settings': {
    testGlobs: ['application/backend/test/settings/**/*.test.ts', 'application/backend/settings/test/**/*.test.ts'],
    coverage: false,
  },
  'file-changes': {
    testGlobs: [
      'application/backend/test/file-changes/**/*.test.ts',
      'application/backend/file-changes/test/**/*.test.ts',
    ],
    coverage: false,
  },
  'transcript-delivery': {
    testGlobs: ['application/backend/test/transcript-delivery/**/*.test.ts'],
    coverage: false,
  },
  'application-validation': {
    testGlobs: ['application/lib/validation/test/**/*.test.ts'],
    coverage: false,
  },
  'cold-browse-helper': {
    testGlobs: ['harness/agent-processes/cold-browse-helper/test/**/*.test.ts'],
    coverageIncludes: ['harness/agent-processes/cold-browse-helper/*.ts'],
    thresholds: { lines: 80, branches: 75 },
  },
  'session-storage-settings': {
    testGlobs: [
      'harness/session-storage/settings/test/**/*.test.ts',
      'harness/tools/package-integrations/mcp/test/**/*.test.ts',
      'test/integration/history-compaction-settings.test.ts',
    ],
    coverageIncludes: [
      'harness/session-storage/settings/*.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
  },
  'agent-processes-workers': {
    testGlobs: [
      'harness/agent-processes/workers/test/**/*.test.ts',
    ],
    coverage: false,
  },
  'agent-processes-sdk-integration': {
    testGlobs: ['harness/agent-processes/lib/sdk-integration/test/**/*.test.ts'],
    coverage: false,
  },
  'web-access-guard': {
    testGlobs: ['harness/tools/package-integrations/web-access/test/**/*.test.ts'],
    coverageIncludes: ['harness/tools/package-integrations/web-access/*.ts'],
    // Package-root lookup is injectable; only the production agent-dir glue
    // remains untestable. Workflow patching and npm repair are fully covered.
    thresholds: { lines: 82, branches: 78 },
  },
  'tool-result-pruner': {
    testGlobs: ['harness/tools/result-processing/test/**/*.test.ts'],
    coverageIncludes: ['extensions/tool-result-pruner/index.ts', 'harness/tools/result-processing/*.ts'],
    // MVP: the lossless rules + pipeline guards are pure functions; the
    // index.ts factory is env-glue (registers a pi.on handler) and is not
    // unit-testable without the pi runtime. Types-global.d.ts is ambient only.
    thresholds: { lines: 92, branches: 80 },
  },
  'deferred-triggers': {
    testGlobs: ['harness/tools/deferred-triggers/test/**/*.test.ts'],
    coverageIncludes: ['harness/tools/deferred-triggers/index.ts', 'harness/tools/deferred-triggers/store.ts', 'harness/tools/deferred-triggers/types.ts'],
    // store.ts (the op-log replay) is the unit-testable core; index.ts is
    // env-glue (registers the `defer_trigger` tool) and types.ts is the schema.
    // types-global.d.ts is ambient only.
    thresholds: { lines: 80, branches: 70 },
  },
  'session-changes': {
    testGlobs: ['harness/tools/session-changes/test/**/*.test.ts'],
    coverageIncludes: ['harness/tools/session-changes/index.ts', 'harness/tools/session-changes/*.ts'],
    // session-jsonl.ts (the JSONL reader + toolCall↔toolResult join), render.ts
    // (TSV/minified-diff renderers), and diff.ts's pure minify/synthetic paths
    // are the unit-testable core; index.ts is env-glue (registers the
    // `session_changes` tool) and diff.ts's git exec is integration-only.
    // types-global.d.ts is ambient only. The shared derivation core + git-baseline
    // live in lib/file-changes/ and are covered by the file-changes package.
    thresholds: { lines: 80, branches: 70 },
  },
  'computer-use': {
    testGlobs: ['harness/tools/computer-use/test/**/*.test.ts'],
    coverageIncludes: [
      'harness/tools/computer-use/index.ts',
      'harness/tools/computer-use/dependency-owner.mjs',
      'harness/tools/computer-use/*.ts',
      'harness/tools/computer-use/*.mjs',
    ],
    thresholds: { lines: 80, branches: 60 },
  },
  'model-provider-request-validation': {
    testGlobs: ['harness/model-providers/request-validation/test/**/*.test.ts'],
    coverageIncludes: [
      'harness/model-providers/request-validation/*.ts',
    ],
    thresholds: { lines: 80, branches: 60 },
  },
  playwright: {
    testGlobs: ['harness/tools/playwright/test/**/*.test.ts'],
    coverageTestGlobs: ['harness/tools/playwright/test/coverage-suite.ts'],
    coverageIncludes: [
      'harness/tools/playwright/index.ts',
      'harness/tools/playwright/dependency-owner.mjs',
      'harness/tools/playwright/*.ts',
      'harness/tools/playwright/*.mjs',
    ],
    thresholds: { lines: 80, branches: 60 },
  },
};

/** Per-package runner configs: registry identity + local test/coverage metadata. */
export const PACKAGE_CONFIGS = PACKAGE_REGISTRY.map((entry) => {
  const metadata = PACKAGE_TEST_METADATA[entry.id];
  if (!metadata) {
    throw new Error(`Package "${entry.id}" is registered in scripts/lib/test-packages.mjs but has no PACKAGE_TEST_METADATA in run-tests.mjs.`);
  }
  return {
    id: entry.id,
    ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
    cwd: entry.testCwd ? path.join(repoRoot, entry.testCwd) : repoRoot,
    ...(entry.tsxConfig ? { tsxConfig: entry.tsxConfig } : {}),
    ...(entry.testTsx ? { testTsx: entry.testTsx } : {}),
    ...(entry.includeOwnerDependencies ? { includeOwnerDependencies: true } : {}),
    // A dedicated fast-batch mode is named after its package.
    ...(entry.fastBatch ? { fastBatchMode: entry.id } : {}),
    ...(entry.fastConcurrency !== undefined ? { fastConcurrency: entry.fastConcurrency } : {}),
    ...metadata,
  };
});

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
      if (config.includeOwnerDependencies) existing.includeOwnerDependencies = true;
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
    // fastConcurrency comes from the package registry via the first member;
    // merged root-group members all share the registry's root budget.
    const isFullRootBatch = isRootGroup
      && ids.length === ROOT_BATCH_PACKAGE_IDS.length
      && ROOT_BATCH_PACKAGE_IDS.every((id) => ids.includes(id));
    return {
      ...group,
      id: ids.length === 1 ? ids[0] : `${ids.length} root packages`,
      fastBatchMode: isFullRootBatch ? 'root' : group.fastBatchMode,
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

/**
 * Run a broad fast suite without multiplying package-level Node runners.
 * Extension tests have their own bundled/esbuild wave and are exclusive with
 * other package runners. Remaining groups share a fixed three-runner budget;
 * each group's node:test concurrency is already bounded by the package registry.
 * Results retain the caller's package order even though extension runs first.
 */
export async function runFastPackageQueue(configs, runConfig, concurrency = 3) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Fast package concurrency must be a positive integer; received ${concurrency}.`);
  }

  const results = new Array(configs.length);
  let hasFailure = false;
  let firstFailure;
  const run = async (index) => {
    try {
      results[index] = await runConfig(configs[index]);
    } catch (error) {
      if (!hasFailure) firstFailure = error;
      hasFailure = true;
    }
  };

  const extensionIndex = configs.findIndex((config) => config.id === 'extension');
  if (extensionIndex !== -1) await run(extensionIndex);

  const queuedIndexes = configs.map((_, index) => index).filter((index) => index !== extensionIndex);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, queuedIndexes.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const queueIndex = nextIndex;
      nextIndex += 1;
      if (queueIndex >= queuedIndexes.length) return;
      await run(queuedIndexes[queueIndex]);
    }
  });

  await Promise.all(workers);
  if (hasFailure) throw firstFailure;
  return results;
}

export function buildFastRunnerArgs(config) {
  const args = config.fastBatchMode ? [config.fastBatchMode] : [];
  // The root runner makes one batch per test root. Honor the shared root
  // package budget instead of launching all roots at once (currently 30 child
  // test processes on a full checkout).
  if (config.fastBatchMode === 'root' && config.fastConcurrency !== undefined) {
    args.push(`--test-concurrency=${config.fastConcurrency}`);
  }
  return args;
}

export function buildTestArgs(config, fast = false, testArgs = []) {
  // `--tsconfig` (when configured) tells tsx which tsconfig to use for module
  // resolution / path aliases. Subagent, Playwright, and Computer-Use use
  // this to resolve the embedded pi SDK's nested typebox/pi-ai to one pinned
  // instance (their `tsxConfig` points at a runtime-only tsconfig whose
  // `paths` target JS builds, not the typecheck-only `.d.ts` aliases). It must
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
      ? ['--test-force-exit', ...(config.fastConcurrency ? [`--test-concurrency=${config.fastConcurrency}`] : [])]
      : ['--test-concurrency=1']),
    ...(collectCoverage ? ['--experimental-test-coverage'] : []),
    // Single-process coverage opt-in: run every test file in one process so the
    // coverage report comes from exactly one child (see 'skill-pruner').
    ...(collectCoverage && config.singleProcessCoverage ? ['--experimental-test-isolation=none'] : []),
    `--test-reporter=${reporterSpecifier}`,
    ...(collectCoverage ? config.coverageIncludes.map((pattern) => `--test-coverage-include=${pattern}`) : []),
    ...testArgs,
    ...(collectCoverage && config.coverageTestGlobs ? config.coverageTestGlobs : config.testGlobs),
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

function runChildProcess(command, args, cwd, signal, envOverrides = {}, verifyCleanExit = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, withProcessTreeIsolation({
      cwd,
      env: { ...withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env)), FORCE_COLOR: '0', ...envOverrides },
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
      let cleanup;
      if (closeSignal === null && !watchdog.terminationStarted && !verifyCleanExit) {
        // A normally closed node:test parent has already joined its workers.
        // Avoid an expensive Windows process-tree census for packages whose
        // tests never spawn descendants; abort/timeout always verifies cleanup.
        watchdog.cleanup();
        cleanup = { gone: true, survivors: [] };
      } else {
        cleanup = await watchdog.settle().catch((error) => ({ gone: false, survivors: [], diagnostics: [String(error)] }));
      }
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
  const useFastRunner = fast && (config.fastRunner || config.fastBatchMode) && testArgs.length === 0;
  const fastRunner = config.fastRunner ?? path.join(repoRoot, 'scripts', 'verification', 'run-fast-batched-tests.mjs');
  const fastRunnerArgs = buildFastRunnerArgs(config);
  // Packages with a registry tsxConfig run through a generated overlay config
  // (owner-relative aliases extending the checked-in base tsconfig) instead of
  // the raw repo-relative path; dedicated fast-batch modes overlay inside
  // their own runner. The overlay is disposed after the run in all paths.
  const tsxOverlay = !useFastRunner && config.tsxConfig
    ? createTsconfigOverlay(path.join(repoRoot, config.tsxConfig), {
      includeOwnerDependencies: config.includeOwnerDependencies === true,
    })
    : null;
  // Invoke the registry-selected tsx CLI directly rather than routing through
  // npx and a platform shell. This preserves regexes/spaces in forwarded
  // node:test arguments and avoids command-resolution differences between cwd/shells.
  let rawResult;
  try {
    const args = useFastRunner ? [] : buildTestArgs(tsxOverlay ? { ...config, tsxConfig: tsxOverlay.configPath } : config, fast, testArgs);
    const tsxCli = config.testTsx === 'root'
      ? resolveLocalTsx(repoRoot)
      : config.id === 'extension' ? resolveOwnerTsx() : resolveLocalTsx(config.cwd);
    rawResult = await runChildProcess(
      process.execPath,
      useFastRunner ? [fastRunner, ...fastRunnerArgs] : [tsxCli, ...args],
      config.cwd,
      signal,
      integration ? { PIE_RUN_INTEGRATION_TESTS: '1' } : {},
      config.id === 'extension' || integration,
    );
  } finally {
    tsxOverlay?.dispose();
  }
  const report = parseReporterOutput(rawResult.stdout, rawResult.stderr);
  const summary = report?.summary ?? null;
  const coverage = report?.coverage ?? null;
  const failures = report?.failures ?? [];
  const fileAccounting = report?.fileAccounting ?? null;
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
    fileAccounting,
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
  const flakySuffix = result.flakyRerun ? ' (flaky: passed on rerun)' : '';

  console.log(`${status} ${config.id} — ${formatCounts(counts)} — ${formatCoverage(coverage)} — ${formatDuration(durationMs)}${flakySuffix}`);

  if (failures.length > 0 && !result.flakyRerun) {
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

/**
 * Rerun-once fallback for failed packages in fast mode.
 *
 * The fast suite deliberately oversubscribes the machine (parallel package
 * runners + file concurrency), so a small class of wall-clock-budget tests can
 * fail transiently under load even though they always pass in isolation. A
 * failed package is re-run once with far less contention; if the rerun passes
 * the failure is reported as flaky and never cached. A rerun that also fails
 * keeps the original failure (with its diagnostics) — this never masks a real
 * regression, it only absorbs load-induced noise.
 */
export async function attemptFlakyRerun(result, fast, integration, testArgs, signal, rerunFiles = runFailedFiles) {
  // The reporter (including the batched runner's aggregate) treats missing or
  // duplicate test-file dispatch as a failure independent of test assertions.
  // A selective rerun can only validate attributed tests, not the original
  // package's file enumeration, so it must not clear that failure.
  const accountingMismatch = result.fileAccounting?.success === false
    || result.failures.some((failure) => failure.name === 'test-file accounting mismatch'
      || failure.name === 'aggregate test-file accounting mismatch');
  if (accountingMismatch) {
    console.log(`✖ ${result.config.id}: original test-file accounting mismatch — flaky rerun skipped; original failure stands.`);
    return result;
  }

  const failedFiles = [...new Set(
    result.failures
      .map((failure) => failure.file)
      .filter((file) => typeof file === 'string' && file.length > 0)
      .map((file) => {
        // Reporters emit absolute paths; tolerate already-relative ones.
        const relative = path.isAbsolute(file)
          ? path.relative(repoRoot, file)
          : file.replace(/^[.\\/]+/u, '');
        return relative.replace(/\\/g, '/');
      })
      .filter((relative) => relative && !relative.startsWith('..') && !path.isAbsolute(relative)),
  )];
  if (failedFiles.length === 0) {
    // No file attribution (infrastructure failure / missing summary) — rerun
    // the whole package so the same load conditions apply.
    const rerun = await runPackage(result.config, fast, integration, testArgs, signal);
    if (rerun.passed) {
      console.log(`⚠ ${result.config.id} failed under parallel load but passed on a full-package rerun — treated as flaky.`);
      return { ...rerun, flakyRerun: true };
    }
    console.log(`✖ ${result.config.id}: rerun also failed — original failure stands.`);
    return result;
  }

  const rerun = await rerunFiles(failedFiles, signal);
  if (rerun.passed) {
    console.log(`⚠ ${result.config.id}: ${failedFiles.length} failing test file(s) (${failedFiles.join(', ')}) passed on rerun — treated as flaky, not cached.`);
    for (const failure of result.failures) console.log(indent(formatFailureDetails(failure), '    '));
    const counts = result.summary?.counts;
    return {
      ...result,
      passed: true,
      hasInfrastructureFailure: false,
      flakyRerun: true,
      // Zero the original failure counts so the aggregate totals reflect the
      // rerun pass, not the transient first-run failure.
      summary: counts ? {
        ...result.summary,
        counts: {
          ...counts,
          passed: (counts.passed ?? 0) + (counts.failed ?? 0),
          failed: 0,
        },
      } : undefined,
    };
  }
  console.log(`✖ ${result.config.id}: rerun of ${failedFiles.join(', ')} also failed — original failure stands.`);
  return result;
}

/** Re-run specific repo-relative test files through the tight dev-loop runner. */
async function runFailedFiles(files, signal) {
  const rawResult = await runChildProcess(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'verification', 'run-test-files.mjs'), ...files],
    repoRoot,
    signal,
    {},
    false,
  );
  return {
    passed: rawResult.exitCode === 0 && !rawResult.timedOut && !rawResult.aborted && rawResult.signal === null,
  };
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
    const runConfig = (config) => runPackage(
      config,
      parsedArgs.fast,
      parsedArgs.integration,
      parsedArgs.testArgs,
      processAbort.signal,
    );
    const isBroadFastSuite = parsedArgs.fast
      && parsedArgs.selected.length === 0
      && parsedArgs.testArgs.length === 0;
    results = isBroadFastSuite
      ? await runFastPackageQueue(executionConfigs, runConfig)
      : await Promise.all(executionConfigs.map(runConfig));
    // Absorb load-induced flakiness in the fast loop: re-run failed packages
    // once under minimal contention before declaring a red suite. Coverage
    // (verify) runs, integration runs, and pattern-filtered runs stay strict.
    if (parsedArgs.fast && parsedArgs.testArgs.length === 0 && !parsedArgs.integration) {
      results = await Promise.all(results.map(async (result) => {
        if (result.passed) return result;
        return await attemptFlakyRerun(
          result,
          parsedArgs.fast,
          parsedArgs.integration,
          parsedArgs.testArgs,
          processAbort.signal,
        );
      }));
    }
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
    const flakyCount = results.filter((result) => result.flakyRerun).length;
    if (flakyCount > 0) {
      console.log(`Summary: ${passedCount}/${results.length} ${packageWord} passed (${flakyCount} flaky on rerun) — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped.`);
    } else {
      console.log(`Summary: ${passedCount}/${results.length} ${packageWord} passed — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped.`);
    }
    if (fingerprint && !results.some((result) => result.flakyRerun)) {
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
