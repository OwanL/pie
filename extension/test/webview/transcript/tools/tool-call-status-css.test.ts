import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readStatusChipCss() {
  return readFile(new URL('../../../../src/webview/panel/styles/status-chip.css', import.meta.url), 'utf8');
}

async function readIndexCss() {
  return readFile(new URL('../../../../src/webview/panel/styles/index.css', import.meta.url), 'utf8');
}

test('shared status chip uses content-sized width for tool/subagent headers', async () => {
  const css = await readStatusChipCss();
  const indexCss = await readIndexCss();
  const baseRule = css.match(/\.status-chip\s*\{[\s\S]*?\n\}/);
  const fixedRule = css.match(/\.status-chip-fixed\s*\{[\s\S]*?\n\}/);

  assert.match(indexCss, /--tool-call-status-column-width:\s*12ch;/);
  assert.match(indexCss, /--status-chip-height:\s*16px;/);
  assert.match(indexCss, /--status-chip-dot-size:\s*4px;/);

  assert.ok(baseRule, 'expected .status-chip base rule in status-chip.css');
  assert.match(baseRule[0], /font-family:\s*var\(--vscode-editor-font-family,\s*monospace\);/);

  assert.ok(fixedRule, 'expected .status-chip-fixed rule in status-chip.css');
  // Fixed variant now auto-sizes to content with a max-width cap
  assert.match(fixedRule[0], /min-width:\s*auto;/);
  assert.match(fixedRule[0], /max-width:\s*var\(--tool-call-status-column-width\);/);
});
