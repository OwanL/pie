import test from 'node:test';
import assert from 'node:assert/strict';

import { isPanelBooting, resolvePanelSurface, resolveLoadingStatus } from '../../../src/webview/panel/panel-state';

test('isPanelBooting treats backend startup without a notice as loading', () => {
  assert.equal(isPanelBooting({ backendReady: false, notice: null }), true);
  assert.equal(isPanelBooting({ backendReady: false, notice: '' }), true);
});

test('isPanelBooting stops once an error notice is present', () => {
  assert.equal(isPanelBooting({ backendReady: false, notice: 'Backend failed to start' }), false);
});

test('resolvePanelSurface shows session surface immediately when tabs exist, even during boot', () => {
  assert.equal(resolvePanelSurface({
    backendReady: false,
    notice: null,
    openTabPaths: ['/workspace/session-a.jsonl'],
  }), 'session');
});

test('resolvePanelSurface shows the empty state once startup has completed without tabs', () => {
  assert.equal(resolvePanelSurface({
    backendReady: true,
    notice: null,
    openTabPaths: [],
  }), 'empty');
});

test('resolvePanelSurface shows the session surface once tabs are available', () => {
  assert.equal(resolvePanelSurface({
    backendReady: true,
    notice: null,
    openTabPaths: ['/workspace/session-a.jsonl'],
  }), 'session');
});

test('resolveLoadingStatus says "Starting pie" on a tab-less cold boot', () => {
  assert.equal(
    resolveLoadingStatus({
      backendReady: false,
      hasOpenTabs: false,
      transcriptHydrating: true,
      needsSessionRecovery: false,
    }),
    'Starting pie',
  );
});

test('resolveLoadingStatus says "Restoring sessions" while booting with tabs open', () => {
  assert.equal(
    resolveLoadingStatus({
      backendReady: false,
      hasOpenTabs: true,
      transcriptHydrating: true,
      needsSessionRecovery: false,
    }),
    'Restoring sessions',
  );
});

test('resolveLoadingStatus prioritises session recovery over backend boot', () => {
  assert.equal(
    resolveLoadingStatus({
      backendReady: false,
      hasOpenTabs: true,
      transcriptHydrating: true,
      needsSessionRecovery: true,
    }),
    'Restoring session',
  );
});

test('resolveLoadingStatus says "Loading conversation" once the backend is up but the transcript is still hydrating', () => {
  assert.equal(
    resolveLoadingStatus({
      backendReady: true,
      hasOpenTabs: true,
      transcriptHydrating: true,
      needsSessionRecovery: false,
    }),
    'Loading conversation',
  );
});

test('resolveLoadingStatus falls back to a generic "Loading" label when no specific phase applies', () => {
  assert.equal(
    resolveLoadingStatus({
      backendReady: true,
      hasOpenTabs: true,
      transcriptHydrating: false,
      needsSessionRecovery: false,
    }),
    'Loading',
  );
});
