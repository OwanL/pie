import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadCompleteSimple } from '../session-title-generator.js';

for (const layout of ['sibling', 'nested'] as const) {
  test(`loadCompleteSimple imports the pi-ai package export in a ${layout} layout`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pie-title-resolution-'));
    try {
      const sdkPath = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
      const aiPath = layout === 'nested'
        ? path.join(sdkPath, 'node_modules', '@earendil-works', 'pi-ai')
        : path.join(root, 'node_modules', '@earendil-works', 'pi-ai');
      await mkdir(sdkPath, { recursive: true });
      await mkdir(path.join(aiPath, 'entry'), { recursive: true });
      await writeFile(path.join(sdkPath, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
      await writeFile(path.join(aiPath, 'package.json'), JSON.stringify({
        name: '@earendil-works/pi-ai',
        type: 'module',
        exports: { '.': { import: './entry/completion.js' } },
      }));
      // A non-dist export and ESM-only entry exercise actual resolution and dynamic import.
      await writeFile(path.join(aiPath, 'entry', 'completion.js'), `
        export async function completeSimple(model, context, options) {
          return { content: [{ type: 'text', text: model.id + ':' + context.systemPrompt + ':' + options.marker }] };
        }
      `);

      const completeSimple = await loadCompleteSimple(sdkPath);
      assert.equal(typeof completeSimple, 'function');
      const result = await completeSimple({ id: layout }, { systemPrompt: 'fixture', messages: [] }, { marker: 'local' });
      assert.deepEqual(result, { content: [{ type: 'text', text: `${layout}:fixture:local` }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
