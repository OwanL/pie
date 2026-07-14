import test from 'node:test';
import assert from 'node:assert/strict';

test('all built-in row kinds have registered renderers', async () => {
  // Trigger side-effect registration
  await import('../../../../src/webview/panel/transcript/register-builtins');
  const { getRegisteredRowKinds } = await import('../../../../src/webview/panel/transcript/registry');

  const kinds = getRegisteredRowKinds();
  for (const expected of ['systemPrompts', 'topGap', 'bottomGap', 'message', 'typingIndicator']) {
    assert.ok(kinds.includes(expected), `Missing row renderer for '${expected}'`);
  }
});

test('all built-in tool names have registered renderers', async () => {
  await import('../../../../src/webview/panel/transcript/register-builtins');
  const { getRegisteredToolNames } = await import('../../../../src/webview/panel/transcript/registry');

  const names = getRegisteredToolNames();
  assert.ok(names.includes('__default'), 'Missing __default tool renderer');
  assert.ok(names.includes('subagent'), 'Missing subagent tool renderer');
});
