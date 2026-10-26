import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';


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
    reload(options?: { resolveProjectTrust: () => Promise<boolean> }): Promise<void> | void;
    getAppendSystemPrompt(): string[];
    getSystemPrompt(): string | undefined;
  };
}> {
  return await import('@earendil-works/pi-coding-agent') as unknown as {
    DefaultResourceLoader: new (options: Record<string, unknown>) => {
      reload(options?: { resolveProjectTrust: () => Promise<boolean> }): Promise<void> | void;
      getAppendSystemPrompt(): string[];
      getSystemPrompt(): string | undefined;
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

test('centralAppendSystemPromptOverride retains default additions before a native personal append', () => {
  const agentDir = makeTempAgentDir();
  try {
    writeCentralAppend(agentDir, 'Central append');
    const override = centralAppendSystemPromptOverride(agentDir);
    assert.ok(override);
    assert.deepEqual(override(['Personal append']), ['Central append', 'Personal append']);
    assert.deepEqual(override([]), ['Central append']);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('missing default guidance retains native additions', () => {
  const agentDir = makeTempAgentDir();
  try {
    assert.deepEqual(centralAppendSystemPromptOverride(agentDir)(['Personal']), ['Personal']);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('native main additions and base replacements remain isolated from empty and nonempty child roles', async () => {
  const { DefaultResourceLoader } = await loadPinnedResourceLoader();
  const agentDir = makeTempAgentDir();
  const cwd = makeTempAgentDir();
  try {
    writeCentralAppend(agentDir, 'Central append');
    // The old agentDir-root location would be natively discovered as the
    // global append; assert the relocated layout is not.
    assert.ok(!fs.existsSync(path.join(agentDir, 'APPEND_SYSTEM.md')));

    fs.writeFileSync(path.join(agentDir, 'APPEND_SYSTEM.md'), 'Personal append');
    fs.mkdirSync(path.join(cwd, '.pi'));
    fs.writeFileSync(path.join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'Project append');

    // The runner supplies an explicit array even for empty roles. Native main
    // appends must not leak into children in that case.
    const emptyRoleLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPrompt: [],
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
    // all applicable additions compose without changing native base discovery.
    const mainLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPromptOverride: centralAppendSystemPromptOverride(agentDir, {
        cwd, isProjectTrusted: () => true,
      }),
      noExtensions: true,
    });
    await mainLoader.reload();
    assert.deepEqual(mainLoader.getAppendSystemPrompt(), ['Central append', 'Personal append', 'Project append']);

    await mainLoader.reload({ resolveProjectTrust: async () => true });
    assert.deepEqual(mainLoader.getAppendSystemPrompt(), ['Central append', 'Personal append', 'Project append']);

    // An explicit native SYSTEM.md replaces only the base, not additions.
    fs.writeFileSync(path.join(cwd, '.pi', 'SYSTEM.md'), 'Project base replacement');
    await mainLoader.reload();
    assert.equal(mainLoader.getSystemPrompt(), 'Project base replacement');
    assert.deepEqual(mainLoader.getAppendSystemPrompt(), ['Central append', 'Personal append', 'Project append']);

    // Use the SDK trust gate, not merely a fabricated empty project array.
    const untrusted = new DefaultResourceLoader({
      cwd, agentDir, noExtensions: true,
      appendSystemPromptOverride: centralAppendSystemPromptOverride(agentDir, {
        cwd, isProjectTrusted: () => false,
      }),
    });
    await untrusted.reload({ resolveProjectTrust: async () => false });
    assert.equal(untrusted.getSystemPrompt(), undefined);
    assert.deepEqual(untrusted.getAppendSystemPrompt(), ['Central append', 'Personal append']);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});