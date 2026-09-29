import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH,
  centralAppendSystemPromptOverride,
  readCentralAppendSystemPrompt,
} from '../append-system-prompt.js';

function makeTempAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pie-append-'));
}

function writeCentralAppend(agentDir: string, content: string): void {
  const filePath = path.join(agentDir, CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Import the pinned SDK resource loader exactly like the context-estimate
 *  worker does, so discovery tests run against the real loader logic. */
async function loadPinnedResourceLoader(): Promise<{
  DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload(): Promise<void> | void;
    getAppendSystemPrompt(): string[];
  };
}> {
  // Resolve against this file, not `process.cwd()`: test packages execute
  // under different working directories.
  const modulePath = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'),
    'application',
    'hosts',
    'vscode',
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'core',
    'resource-loader.js',
  );
  return await import(pathToFileURL(modulePath).href) as unknown as {
    DefaultResourceLoader: new (options: Record<string, unknown>) => {
      reload(): Promise<void> | void;
      getAppendSystemPrompt(): string[];
    };
  };
}

test('readCentralAppendSystemPrompt reads the relocated APPEND_SYSTEM.md from the agent instructions tree', () => {
  const agentDir = makeTempAgentDir();
  try {
    writeCentralAppend(agentDir, '# Working preferences\n\n- Prefer focused tests.\n');
    assert.equal(
      readCentralAppendSystemPrompt(agentDir),
      '# Working preferences\n\n- Prefer focused tests.',
    );
    assert.equal(
      CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH,
      path.join('harness', 'agent-instructions', 'APPEND_SYSTEM.md'),
    );
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('readCentralAppendSystemPrompt returns undefined when the file is absent, blank, or the agentDir is empty', () => {
  const agentDir = makeTempAgentDir();
  try {
    assert.equal(readCentralAppendSystemPrompt(agentDir), undefined);
    writeCentralAppend(agentDir, '   \n');
    assert.equal(readCentralAppendSystemPrompt(agentDir), undefined);
    assert.equal(readCentralAppendSystemPrompt(''), undefined);
    assert.equal(readCentralAppendSystemPrompt('   '), undefined);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('centralAppendSystemPromptOverride preserves natively discovered appends and adds the central one only on an empty base', () => {
  const agentDir = makeTempAgentDir();
  try {
    writeCentralAppend(agentDir, 'Central append');
    const override = centralAppendSystemPromptOverride(agentDir);
    assert.ok(override);
    // A trusted project's own `.pi/APPEND_SYSTEM.md` keeps winning, matching
    // the previous single-file discovery semantics.
    assert.deepEqual(override(['Project append']), ['Project append']);
    // Otherwise the centralized maintainer append is attached.
    assert.deepEqual(override([]), ['Central append']);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('centralAppendSystemPromptOverride is undefined without a central file so loaders keep native behavior', () => {
  const agentDir = makeTempAgentDir();
  try {
    assert.equal(centralAppendSystemPromptOverride(agentDir), undefined);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('the relocated APPEND_SYSTEM.md is outside every native discovery path, including the empty role-instructions subagent fallback', async () => {
  const { DefaultResourceLoader } = await loadPinnedResourceLoader();
  const agentDir = makeTempAgentDir();
  const cwd = makeTempAgentDir();
  try {
    writeCentralAppend(agentDir, 'Central append');
    // The old agentDir-root location would be natively discovered as the
    // global append; assert the relocated layout is not.
    assert.ok(!fs.existsSync(path.join(agentDir, 'APPEND_SYSTEM.md')));

    // Subagent loader shape (runner.ts) with empty role instructions: no
    // explicit append and no Pie override, so no append may be discovered.
    const emptyRoleLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
    });
    await emptyRoleLoader.reload();
    assert.deepEqual(emptyRoleLoader.getAppendSystemPrompt(), []);

    // Subagent loader shape with explicit role instructions: only the role
    // instructions are appended.
    const roleLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPrompt: ['Role instructions'],
      noExtensions: true,
    });
    await roleLoader.reload();
    assert.deepEqual(roleLoader.getAppendSystemPrompt(), ['Role instructions']);

    // Main-session loader shape (runtime-factory / initial-context inventory):
    // the override attaches the centralized append.
    const mainLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPromptOverride: centralAppendSystemPromptOverride(agentDir),
      noExtensions: true,
    });
    await mainLoader.reload();
    assert.deepEqual(mainLoader.getAppendSystemPrompt(), ['Central append']);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});