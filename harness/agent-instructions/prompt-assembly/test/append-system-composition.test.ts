import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { centralAppendSystemPromptOverride, CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH } from '../append-system-prompt.js';
import { APPEND_ENTRY_ID, applySystemPromptTogglesToOptions } from '../system-prompts.js';

function fixture(run: (root: string, put: (name: string, text: string) => string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-composition-'));
  try {
    run(root, (name, text) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('main composition adds defaults, personal and only the native eligible project', () => fixture((root, put) => {
  put(CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH, 'Defaults');
  put('APPEND_SYSTEM.md', 'Personal');
  put('.pi/APPEND_SYSTEM.md', 'Project');
  put('unrelated/.pi/APPEND_SYSTEM.md', 'Unrelated');
  const compose = centralAppendSystemPromptOverride(root, { cwd: root });
  const composed = compose(['Project']);
  assert.deepEqual(composed, ['Defaults', 'Personal', 'Project']);
  const promptOptions = { customPrompt: 'Explicit base', appendSystemPrompt: composed.join('\n\n') };
  assert.equal(applySystemPromptTogglesToOptions(promptOptions, new Set()).appendSystemPrompt, composed.join('\n\n'));
  const disabled = applySystemPromptTogglesToOptions(promptOptions, new Set([APPEND_ENTRY_ID]));
  assert.equal(disabled.appendSystemPrompt, undefined);
  assert.equal(disabled.customPrompt, 'Explicit base');
  const untrusted = centralAppendSystemPromptOverride(root, { cwd: root, isProjectTrusted: () => false });
  assert.deepEqual(untrusted(['Personal']), ['Defaults', 'Personal']);
}));

test('missing and empty project selections do not remove enabled earlier layers', () => fixture((root, put) => {
  put(CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH, 'Defaults');
  put('APPEND_SYSTEM.md', 'Personal');
  const compose = centralAppendSystemPromptOverride(root, { cwd: root });
  assert.deepEqual(compose(['Personal']), ['Defaults', 'Personal']);
  put('.pi/APPEND_SYSTEM.md', '');
  assert.deepEqual(compose([]), ['Defaults', 'Personal']);
  put('APPEND_SYSTEM.md', '  \n');
  assert.deepEqual(compose([]), ['Defaults']);
}));

test('explicit default path deduplicates file routes, not identical intentional additions', () => fixture((root, put) => {
  const personal = put('APPEND_SYSTEM.md', 'Same guidance');
  put('.pi/APPEND_SYSTEM.md', 'Same guidance');
  assert.deepEqual(centralAppendSystemPromptOverride(root, {
    cwd: root, defaultPromptPath: personal,
  })(['Same guidance']), ['Same guidance', 'Same guidance']);
  const separateDefault = put('defaults/APPEND_SYSTEM.md', 'Same guidance');
  assert.deepEqual(centralAppendSystemPromptOverride(root, {
    cwd: root, defaultPromptPath: separateDefault,
  })(['Same guidance']), ['Same guidance', 'Same guidance', 'Same guidance']);
}));

test('same file reached through a source junction is included once', () => fixture((root, put) => {
  const personal = put('APPEND_SYSTEM.md', 'Personal');
  // Directory junctions also work on Windows without symlink privileges.
  fs.symlinkSync(root, path.join(root, 'alias'), 'junction');
  assert.deepEqual(centralAppendSystemPromptOverride(root, {
    cwd: root, defaultPromptPath: path.join(root, 'alias', path.basename(personal)),
  })(['Personal']), ['Personal']);
}));
