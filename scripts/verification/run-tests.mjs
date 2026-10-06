#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
import { PACKAGE_REGISTRY } from '../lib/test-packages.mjs';
import { resolveLocalTsx } from './run-test-files.mjs';

import { extractRuntimeArgs, verificationChildEnv, withVerificationRuntime } from './verification-runtime.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const reporterSpecifier = pathToFileURL(path.join(__dirname, 'test-reporter.mjs')).href;

// Package identity, ordering, aliases, test cwd, tsx/tsc compiler selection,
// and fast concurrency live in scripts/lib/test-packages.mjs
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
      '../../../test/integration/pie-harness-prompt.artifact.test.ts',
      '../../../test/integration/system-prompt-provider-payload.artifact.test.ts',
      '../../../test/integration/perf/auto-follow-reflow.test.ts',
      '../../../test/integration/perf/webview-render-count.test.ts',
      '../../../test/integration/worker-detail-webview-seam.test.ts',
      '../../frontend/**/*.test.ts',
      '../../frontend/**/*.test.tsx',
      '../../lib/protocol/test/**/*.test.ts',
      '../../lib/test/**/*.test.ts',
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
      // Retain the frontend/host implementation denominator after shared-source moves.
      '../../lib/composer/*.ts',
      '../../lib/session-tabs/*.ts',
      '../../lib/transcript/*.ts',
      '../../lib/platform-contracts/*.ts',
      '../../lib/renderer-delivery/*.ts',
      '../../lib/stream-telemetry.ts',
      '**/*.ts',
      '**/*.tsx',
      '../**/*.ts',
      '../**/*.tsx',
      '../../../harness/session-storage/lifecycle/session-filesystem-lifecycle.ts',
      '../../../harness/session-storage/metadata/session-name.ts',
      '../../../harness/session-storage/ownership/session-identity.ts',
    ],
    thresholds: { lines: 80, branches: 75 },
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
      'scripts/model-config/test/**/*.test.mjs',
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
      'test/integration/dynamic-tool-activation.artifact.test.ts',
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
      'test/integration/real-sdk-image-persistence.artifact.test.ts',
      'test/integration/sdk-terminal-durability.artifact.test.ts',
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
    // NODE_V8_COVERAGE supplies detailed raw blocks; qualified source accounting
    // is authoritative. Do not also compute Node's unused native aggregate.
    // Single-process coverage opt-in: run every test file in one process so the
    // coverage report comes from exactly one child (see 'skill-pruner').
    ...(collectCoverage && config.singleProcessCoverage ? ['--experimental-test-isolation=none'] : []),
    `--test-reporter=${reporterSpecifier}`,
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

export async function runChildProcess(command, args, cwd, signal, envOverrides = {}, verifyCleanExit = false, {
  spawnImpl = spawn, watchChildProcessImpl = watchChildProcess,
} = {}) {
  const child = spawnImpl(command, args, withProcessTreeIsolation({
    cwd,
    env: verificationChildEnv({ ...withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env)), FORCE_COLOR: '0', ...envOverrides }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }));

  let stdout = '';
  let stderr = '';
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const closed = new Promise((resolve) => child.once('close', (exitCode, closeSignal) => resolve({ exitCode, closeSignal })));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const timeoutMs = resolveChildProcessTimeoutMs();
  let watchdog;
  try {
    watchdog = watchChildProcessImpl(child, {
      timeoutMs,
      signal,
      label: `${path.basename(cwd)} tests`,
      onTerminate: ({ reason }) => {
        const detail = reason === 'timeout' ? ` after ${timeoutMs}ms` : '';
        stderr += `\nTest process ${reason === 'timeout' ? 'timed out' : 'was aborted'}${detail}; terminating process tree.\n`;
      },
    });
  } catch (error) {
    return { exitCode: 125, signal: null, stdout, stderr, teardownConfirmed: false, diagnostics: [String(error)] };
  }

  const { exitCode, closeSignal } = await closed;
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
  const teardownConfirmed = cleanup.gone && exitCode !== 125;
  return {
    exitCode: !teardownConfirmed ? 125 : spawnError || watchdog.timedOut || watchdog.aborted ? 1 : (exitCode ?? 1),
    teardownConfirmed,
    diagnostics: [...(cleanup.diagnostics ?? []),
      ...(!cleanup.gone ? [`Test tree teardown is unconfirmed; survivors: ${(cleanup.survivors ?? []).join(', ') || 'unknown'}`] : []),
      ...(exitCode === 125 ? ['Nested test tree teardown is unconfirmed'] : []),
      ...(spawnError ? [String(spawnError)] : [])],
    signal: closeSignal,
    stdout,
    stderr,
    timedOut: watchdog.timedOut,
    aborted: watchdog.aborted,
  };
}

export function buildNativePackageArgs(config, runtime, testArgs = []) {
  // Registry globs are relative to each owner's test cwd, while the native
  // runner discovers indexed/nonignored files relative to the repository.
  const globs = config.testGlobs.map((glob) =>
    path.relative(repoRoot, path.resolve(config.cwd, glob)).replaceAll('\\', '/'));
  const includes = globs.flatMap((glob) => ['--include', glob]);
  const selectors = [...new Set(globs.map((glob) => {
    const wildcard = glob.search(/[*?{\[]/u);
    return wildcard < 0 ? glob : glob.slice(0, glob.lastIndexOf('/', wildcard)) || '.';
  }))];
  return [
    path.join(repoRoot, 'scripts', 'verification', 'test-node.mjs'),
    '--tsconfig', config.tsxConfig ?? 'application/hosts/vscode/tsconfig.json',
    '--sdk-path', runtime.sdkPath,
    ...includes,
    ...selectors,
    '--',
    `--test-reporter=${path.join(__dirname, 'test-reporter.mjs')}`,
    ...testArgs,
  ];
}

export function createCoverageScope() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-source-coverage-'));
  try { mkdirSync(path.join(directory, 'v8')); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  return { directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

async function collectCoverage(options) {
  const errors = readdirSync(options.directory).filter((name) => name.startsWith('recorder-error-'));
  if (errors.length) throw Object.assign(new Error(`Source capture failed: ${errors.join(', ')}`), { exitCode: 125 });
  const { collectSourceCoverage } = await import('./source-coverage.mjs');
  return collectSourceCoverage(options);
}

function coverageDiagnostics(coverage) {
  return (coverage?.files ?? [])
    .filter((file) => file.coveredLineCount < file.totalLineCount || file.coveredBranchCount < file.totalBranchCount)
    .sort((a, b) => (b.totalLineCount - b.coveredLineCount) - (a.totalLineCount - a.coveredLineCount))
    .slice(0, 10)
    .map((file) => `${path.relative(repoRoot, file.path).replaceAll('\\', '/')} — ${formatCoverage(file)}; uncovered lines: ${file.lines.filter((line) => line.count === 0).map((line) => line.line).join(', ') || 'none'}`);
}

export async function runPackage(config, fast = false, integration = false, testArgs = [], signal, runtime, {
  createOverlay = createTsconfigOverlay, runChild = runChildProcess,
  createCoverageScope: makeCoverageScope = createCoverageScope, collectCoverage: accountCoverage = collectCoverage,
  resolveTsx = (owner) => owner.testTsx === 'root' ? resolveLocalTsx(repoRoot)
    : owner.id === 'extension' ? resolveOwnerTsx() : resolveLocalTsx(owner.cwd),
} = {}) {
  // Packages with a registry tsxConfig run through a generated overlay config
  // (owner-relative aliases extending the checked-in base tsconfig) instead of
  // the raw repo-relative path. Native fast runs manage their own overlay.
  // Retain aliases while any child lifetime remains unconfirmed.
  const tsxOverlay = !fast
    ? createOverlay(path.join(repoRoot, config.tsxConfig ?? 'application/hosts/vscode/tsconfig.json'), {
      includeOwnerDependencies: config.includeOwnerDependencies === true,
      sdkPath: runtime.sdkPath,
    })
    : null;
  // Invoke the registry-selected tsx CLI directly rather than routing through
  // npx and a platform shell. This preserves regexes/spaces in forwarded
  // node:test arguments and avoids command-resolution differences between cwd/shells.
  let rawResult;
  let coverageScope;
  let sourceCoverage = null;
  let coverageCaptured = false;
  let coverageError;
  const coveredOwner = !fast && config.coverage !== false;
  let teardownConfirmed = true;
  try {
    if (coveredOwner) coverageScope = makeCoverageScope(config);
    const args = fast ? buildNativePackageArgs(config, runtime, testArgs) : [
      resolveTsx(config),
      ...buildTestArgs({ ...config, tsxConfig: tsxOverlay.configPath }, false, testArgs),
    ];
    teardownConfirmed = false;
    rawResult = await runChild(
      process.execPath,
      args,
      fast ? repoRoot : config.cwd,
      signal,
      {
        ...(integration ? { PIE_RUN_INTEGRATION_TESTS: '1' } : {}),
        ...(coverageScope ? {
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(path.join(__dirname, 'coverage-capture.cjs'))}`,
            ...(!config.singleProcessCoverage ? ['--inspect-port=0'] : [])].filter(Boolean).join(' '),
          PIE_TEST_COVERAGE_DIR: coverageScope.directory,
          PIE_TEST_COVERAGE_ROOT: repoRoot,
          PIE_TEST_COVERAGE_CWD: config.cwd,
          PIE_TEST_COVERAGE_INCLUDES: JSON.stringify(config.coverageIncludes),
          NODE_V8_COVERAGE: path.join(coverageScope.directory, 'v8'),
          // Measurement only: Jiti's SDK discovery transforms need inline maps.
          JITI_SOURCE_MAPS: 'true',
          // Exercise the existing isolated shell contract without enabling provider integration.
          ...(config.id === 'warm-bash' ? { PIE_RUN_WARM_BASH_POOL_TESTS: '1' } : {}),
        } : {}),
      },
      true,
    );
    teardownConfirmed = rawResult.teardownConfirmed === true && rawResult.exitCode !== 125;
    if (coverageScope && teardownConfirmed) {
      try {
        sourceCoverage = await accountCoverage({ directory: coverageScope.directory, root: repoRoot,
          cwd: config.cwd, includes: config.coverageIncludes });
        if (!sourceCoverage?.files?.length) throw new Error('Qualified source coverage records missing');
        coverageCaptured = true;
      } catch (error) {
        sourceCoverage = null;
        if (error.exitCode === 125) {
          rawResult.exitCode = 125;
          rawResult.teardownConfirmed = false;
          teardownConfirmed = false;
        }
        const causes = [];
        for (let cause = error; cause; cause = cause.cause) causes.push(String(cause));
        coverageError = `Qualified source coverage failed: ${causes.join('; caused by ')}`;
        rawResult.diagnostics = [...(rawResult.diagnostics ?? []), coverageError];
      }
    }
  } catch (error) {
    rawResult = { stdout: '', stderr: '', signal: null, ...error.rawResult,
      exitCode: teardownConfirmed ? 1 : 125, teardownConfirmed,
      diagnostics: [String(error), ...(error.rawResult?.diagnostics ?? [])] };
  } finally {
    if (teardownConfirmed && (!coverageScope || coverageCaptured)) tsxOverlay?.dispose();
    if (teardownConfirmed && coverageCaptured) coverageScope?.dispose();
  }
  let report;
  try { report = parseReporterOutput(rawResult.stdout, rawResult.stderr); }
  catch (error) { rawResult.diagnostics = [...(rawResult.diagnostics ?? []), `Invalid test summary: ${error}`]; }
  const summary = report?.summary ?? null;
  const coverage = coveredOwner ? sourceCoverage : report?.coverage ?? null;
  const failures = report?.failures ?? [];
  const fileAccounting = report?.fileAccounting ?? null;
  const coverageFailures = fast ? [] : summarizeCoverageFailures(config, coverage);

  const hasTestFailures = Boolean(summary && (!summary.success || (summary.counts?.failed ?? 0) > 0 || failures.length > 0));
  const hasInfrastructureFailure = Boolean(coverageError) || !teardownConfirmed || !summary || rawResult.signal !== null || rawResult.timedOut || rawResult.aborted || (rawResult.exitCode !== 0 && !hasTestFailures);
  const passed = !hasInfrastructureFailure && !hasTestFailures && coverageFailures.length === 0;

  return {
    config,
    teardownConfirmed,
    retainedOverlay: !teardownConfirmed || (coverageScope && !coverageCaptured) ? tsxOverlay?.configPath : undefined,
    retainedCoverage: coverageScope && !coverageCaptured ? coverageScope.directory : undefined,
    coverageDiagnostics: coverageDiagnostics(coverage),
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
    for (const diagnostic of result.coverageDiagnostics ?? []) console.log(indent(`- ${diagnostic}`, '    '));
  }

  if (result.retainedCoverage) console.log(indent(`- retaining source coverage evidence: ${result.retainedCoverage}`, '    '));
  if (result.teardownConfirmed && result.retainedOverlay) console.log(indent(`- retaining coverage overlay for accounting diagnostics: ${result.retainedOverlay}`, '    '));
  if (hasInfrastructureFailure) {
    for (const diagnostic of rawResult.diagnostics ?? []) console.log(indent(`- ${diagnostic}`, '    '));
    if (!result.teardownConfirmed) console.log(indent(`- retaining runtime${result.retainedOverlay ? ` and coverage overlay ${result.retainedOverlay}` : ''}: child lifetime unconfirmed`, '    '));
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
  let selection;
  try {
    selection = extractRuntimeArgs(process.argv.slice(2));
    parsedArgs = parseArgs(selection.args);
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

  const processAbort = abortOnProcessSignals();
  try {
    await withVerificationRuntime(selection, processAbort.signal, (runtime) =>
      runSelectedPackages(parsedArgs, selectedPackages, runtime, processAbort.signal));
  } finally {
    processAbort.dispose();
  }
}

export async function runSelectedPackages(parsedArgs, selectedPackages, runtime, signal, {
  runPackageImpl = runPackage, printResult = printPackageResult,
} = {}) {
  // Keep each registry owner's config and selection intact. Native file
  // concurrency is bounded by test-node; run owners sequentially in fast mode
  // instead of multiplying that budget or merging incompatible owner aliases.
  const executionConfigs = selectedPackages;

  const runConfig = async (config) => {
    try {
      return await runPackageImpl(
        config,
        parsedArgs.fast,
        parsedArgs.integration,
        parsedArgs.testArgs,
        signal,
        runtime,
      );
    } catch (error) {
      // A rejected owner cannot supply a teardown proof. Join siblings before
      // propagating uncertainty, and preserve any attached process evidence.
      return { config, passed: false, teardownConfirmed: false, hasInfrastructureFailure: true,
        summary: null, coverage: null, failures: [], coverageFailures: [],
        rawResult: { stdout: '', stderr: '', signal: null, ...error.rawResult,
          exitCode: 125, teardownConfirmed: false, diagnostics: [String(error), ...(error.rawResult?.diagnostics ?? [])] } };
    }
  };
  const results = [];
  let nextIndex = 0;
  const runNext = async () => {
    while (nextIndex < executionConfigs.length && !signal?.aborted) {
      const index = nextIndex++;
      // Ordinary failures (including uncertain teardown) remain outcomes, not
      // admission failures. Only cancellation stops launching selected owners.
      results[index] = await runConfig(executionConfigs[index]);
    }
  };
  // Rolling slots bound legacy owner startup/census load without changing test
  // selection, per-owner deadlines, coverage gates, or native file concurrency.
  // Each slot joins its current owner before refilling; all slots are joined
  // before printing in selection order or propagating uncertain lifetime.
  await Promise.all(Array.from({ length: Math.min(parsedArgs.fast ? 1 : 4, executionConfigs.length) }, runNext));
  for (const result of results) {
    printResult(result);
  }

  const uncertain = results.some((result) => !result.teardownConfirmed);
  const totals = aggregateCounts(results);
  const failedResults = results.filter((result) => !result.passed);
  const passedCount = results.length - failedResults.length;
  const packageWord = results.length === 1 ? 'package' : 'packages';

  console.log('');
  if (signal?.aborted) {
    console.log(`Runner interrupted; ${executionConfigs.length - results.length} selected owners not launched.`);
    process.exitCode = 1;
  }
  if (failedResults.length === 0) {
    console.log(`Summary: ${passedCount}/${results.length} ${packageWord} passed — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped.`);
    return;
  }

  const failedPackageIds = failedResults.map((result) => result.config.id).join(', ');
  console.log(`Summary: ${passedCount}/${results.length} ${packageWord} passed — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped.`);
  console.log(`Failed packages: ${failedPackageIds}`);
  if (uncertain) throw Object.assign(new Error('Package child teardown is unconfirmed; retaining verification runtime'), { teardownUnconfirmed: true });
  process.exitCode = 1;
}

// Keep pure argument/command construction importable by focused script tests.
const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await main().catch((error) => { console.error(error.message); process.exitCode = error.teardownUnconfirmed === true ? 125 : 1; });
}
