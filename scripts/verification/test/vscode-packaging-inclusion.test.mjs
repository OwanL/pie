import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const owner = new URL('../../../application/hosts/vscode/package.json', import.meta.url);
const require = createRequire(owner);
// Use the installed distribution owner's collector, not a glob approximation.
// The public api.js wrapper overwrites dependencies with packageManager; this
// underlying listFiles API accepts dependencies:false directly, as the CLI does.
const { listFiles } = require('@vscode/vsce/out/package');

test('VS Code package selects reviewed resources, including nested managed dependencies', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pie-vsce-inclusion-'));
  try {
    await copyFile(new URL('../../../application/hosts/vscode/.vscodeignore', import.meta.url), path.join(cwd, '.vscodeignore'));
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'pie-packaging-fixture', publisher: 'fixture', version: '0.0.0',
      license: 'AGPL-3.0-only',
      engines: { vscode: '^1.90.0' },
      // Listing must neither resolve dependencies nor invoke lifecycle scripts.
      dependencies: { 'not-installed-fixture': '0.0.0' },
      scripts: { 'vscode:prepublish': 'node -e "process.exit(99)"' },
    }));
    const included = [
      'README.md', 'LICENSE', 'COPYRIGHT', 'media/icon.svg', 'runtime/loader.cjs', 'out/extension.js',
      'out/pie-build-id.txt', 'out/windows-runtime-lock.cjs',
      'out/pi-runtime/manifest.json', 'out/pi-runtime/node_modules/example/index.js',
      'out/webview/panel/.vite/manifest.json', 'out/webview/panel/assets/panel.js',
      'out/resources/agent-instructions/APPEND_SYSTEM.md',
      'out/resources/agent-instructions/agents/reviewer.md',
      'out/resources/agent-instructions/skills/nested/example/SKILL.md',
      'out/resources/bundled-extensions.json',
      'out/resources/bundled-extensions-build-id.txt',
      'out/resources/tool-runtimes/manifest.json',
      'out/resources/tool-runtimes/harness/tools/playwright/sidecar.mjs',
      'out/resources/managed-integrations/manifest.json',
      'out/resources/managed-integrations/node_modules/pi-web-access/index.ts',
      'out/resources/managed-integrations/node_modules/pi-web-access/node_modules/@mozilla/readability/Readability.js',
      'out/resources/managed-integrations/node_modules/@scope/native/prebuilds/win32-x64/binding.node',
      'out/resources/managed-integrations/node_modules/@scope/native/vendor/helper.dll',
      'out/resources/managed-integrations/node_modules/@scope/native/.asset-data',
    ];
    const excluded = [
      'src/extension.ts', 'settings.json', 'auth.json', 'agents/personal.md',
      'skills/personal/SKILL.md', 'data/sessions/private.jsonl', 'logs/private.log',
      'node_modules/unrelated/index.js', 'out-dev/extension.js',
      'out/resources/unreviewed/private.txt', 'out/resources/private.json',
      'out/resources/bundled-extensions.json.bak',
      'out/resources/bundled-extensions-build-id.txt.bak',
      'out/resources/agent-instructions-personal/private.md',
      'out/resources/tool-runtimes-personal/private.mjs',
      'out/resources/managed-integrations-personal/private.json',
    ];
    for (const file of [...included, ...excluded]) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      if (file === 'LICENSE' || file === 'COPYRIGHT') {
        await copyFile(new URL(`../../../${file}`, import.meta.url), path.join(cwd, file));
      } else {
        await writeFile(path.join(cwd, file), 'fixture\n');
      }
    }
    const files = await listFiles({ cwd, dependencies: false, prepublish: false });
    assert.deepEqual([...files].sort(), ['package.json', ...included].sort());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
