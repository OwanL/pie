import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWindowsFlashScript,
  shouldFlashFinishedTab,
  shouldShowCompletionNotification,
} from '../../../src/host/sidebar/completion-notification';

test('window attention is suppressed when the user opts out', () => {
  assert.equal(
    shouldShowCompletionNotification({
      suppressNotifications: true,
      windowFocused: false,
    }),
    false,
  );
});

test('window attention only triggers while VS Code is unfocused', () => {
  assert.equal(
    shouldShowCompletionNotification({
      suppressNotifications: false,
      windowFocused: false,
    }),
    true,
  );
  assert.equal(
    shouldShowCompletionNotification({
      suppressNotifications: false,
      windowFocused: true,
    }),
    false,
  );
});

test('finished tabs flash only for background sessions when alerts are enabled', () => {
  assert.equal(
    shouldFlashFinishedTab({
      suppressNotifications: false,
      sessionIsActive: false,
    }),
    true,
  );
  assert.equal(
    shouldFlashFinishedTab({
      suppressNotifications: false,
      sessionIsActive: true,
    }),
    false,
  );
  assert.equal(
    shouldFlashFinishedTab({
      suppressNotifications: true,
      sessionIsActive: false,
    }),
    false,
  );
});

test('windows flash script scopes by app and workspace names', () => {
  const script = buildWindowsFlashScript("Visual Studio Code", "Alice's Project");
  assert.match(script, /\$appName = 'Visual Studio Code'/);
  assert.match(script, /\$workspaceName = 'Alice''s Project'/);
  assert.match(script, /FlashWindowEx/);
  assert.match(script, /ProcessName -like 'Code\*'/);
});
