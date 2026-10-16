import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (path: string) => readFileSync(`application/frontend/${path}`, 'utf8');

test('action rows omit placeholder checks while preference toggles retain state', () => {
  const transcript = source('lib/components/context-menu.tsx');
  assert.doesNotMatch(transcript, /style="opacity:0"/);
  assert.match(transcript, /style=\{checked \?/);
  assert.doesNotMatch(source('session-tabs/pinned-group-context-menu.tsx'), /CheckmarkIcon/);
  assert.doesNotMatch(source('file-changes/file-changes-context-menu.tsx'), /context-menu-check/);
});

test('management menus omit redundant headers but preserve trigger context', () => {
  assert.doesNotMatch(source('session-tabs/snoozed-sessions-menu.tsx'), /session-tab-context-title|snoozed-session-restore/);
  const triggers = source('analytics/aggregate-stats-strip/deferred-triggers-menu.tsx');
  assert.doesNotMatch(triggers, /deferred-triggers-menu-title/);
  for (const detail of ['formatTriggerSpecs', 'formatDeliveryState', 'creatorName', 'formatElapsed', 'title={message}']) {
    assert.ok(triggers.includes(detail), detail);
  }
  assert.match(triggers, /Cancel\s*<\/button>/);
});

test('action rows use compact consistent metrics', () => {
  const css = source('styles/context-menu.css');
  assert.match(css, /min-height: 24px/);
  assert.match(css, /padding: 3px 10px/);
  assert.match(css, /line-height: 18px/);
});
