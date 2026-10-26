import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceDescriptor } from '../../harness/agent-processes/lib/sdk-integration/test/source-fixture.js';
import { buildSanitizedRealChildTestEnv } from '../../harness/agent-processes/test/fixtures/sanitized-real-child-env.js';

// This exercises selected SDK bytes + source policies, NOT delivered application updates.
test('private customisations and saved settings survive fresh discovery processes and resource replacement', { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-customisation-persistence-'));
  let confirmedExit = true;
  const put = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const role = (body: string) => `---\nname: fixture-role\ndescription: fixture role\ntools: []\ncanSpawn: []\n---\n${body}\n`;
  const skill = (body: string) => `---\nname: fixture-skill\ndescription: fixture skill\n---\n${body}\n`;
  try {
    for (const generation of ['old', 'new']) {
      const base = `${generation}/resources/agent-instructions`;
      put(`${base}/APPEND_SYSTEM.md`, `${generation} bundled main`);
      put(`${base}/SUBAGENT_SYSTEM.md`, `${generation} bundled child`);
      put(`${base}/agents/fixture.md`, role(`${generation} bundled role`));
      put(`${base}/skills/fixture-skill/SKILL.md`, skill(`${generation} bundled skill`));
    }
    for (const workspace of ['project-a', 'project-b']) fs.mkdirSync(path.join(root, workspace));
    put('agent/settings.json', '{}');
    const preserved = [
      put('agent/APPEND_SYSTEM.md', 'private main addition'),
      put('agent/SUBAGENT_SYSTEM.md', 'private child addition'),
      put('agent/agents/fixture.md', role('private role')),
      put('agent/skills/fixture-skill/SKILL.md', skill('private skill')),
    ];
    const snapshots = preserved.map(file => fs.readFileSync(file));
    const worker = fileURLToPath(new URL('./fixtures/customisation-persistence-worker.ts', import.meta.url));
    const repo = path.resolve(path.dirname(worker), '../../..');
    const run = (generation: string, workspace = 'project-b', save = '') => {
      const env = buildSanitizedRealChildTestEnv(process.env, root, 'inventory');
      env.TSX_TSCONFIG_PATH = process.env.TSX_TSCONFIG_PATH;
      const result = spawnSync(process.execPath, ['--require', path.join(repo, 'node_modules/tsx/dist/cjs/index.cjs'), worker, sourceDescriptor.sdkPath, root, generation, workspace, save], { cwd: root, env, encoding: 'utf8', timeout: 25_000, windowsHide: true });
      confirmedExit = result.status !== null && !result.error;
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    const first = run('old', 'project-b', 'save');
    assert.ok(first.main.join('\n').includes('old bundled main'));
    const settings = fs.readFileSync(path.join(root, 'agent/settings.json'));
    const updated = run('new');
    assert.equal(updated.theme, 'private-saved-theme');
    assert.ok(updated.main.join('\n').includes('new bundled main'));
    assert.ok(updated.main.join('\n').includes('private main addition'));
    assert.equal(updated.role, 'private role');
    assert.ok(updated.skill.includes('private skill'));
    assert.ok(updated.child.join('\n').includes('new bundled child'));
    assert.ok(updated.child.join('\n').includes('private child addition'));
    assert.ok(!updated.child.join('\n').includes('private main addition'));
    const projectRole = put('project-a/agents/fixture.md', role('project role'));
    const projectSkill = put('project-a/skills/fixture-skill/SKILL.md', skill('project skill'));
    put('project-a/.pi/APPEND_SYSTEM.md', 'project main addition');
    const project = run('new', 'project-a');
    assert.equal(project.role, 'project role');
    assert.ok(project.skill.includes('project skill'));
    assert.ok(project.main.join('\n').includes('project main addition'));
    assert.ok(!project.child.join('\n').includes('project main addition'));
    const isolated = run('new');
    assert.equal(isolated.role, 'private role');
    assert.ok(isolated.skill.includes('private skill'));
    assert.ok(!isolated.main.join('\n').includes('project main addition'));
    for (const [index, file] of preserved.entries()) assert.deepEqual(fs.readFileSync(file), snapshots[index]);
    assert.deepEqual(fs.readFileSync(path.join(root, 'agent/settings.json')), settings);
    for (const file of [projectRole, projectSkill, preserved[2], preserved[3]]) fs.unlinkSync(file);
    const restored = run('new', 'project-a');
    assert.equal(restored.role, 'new bundled role');
    assert.ok(restored.skill.includes('new bundled skill'));
    assert.equal(restored.theme, 'private-saved-theme');
    assert.deepEqual(fs.readFileSync(path.join(root, 'agent/settings.json')), settings);
  } finally {
    // Guarded children cannot spawn descendants; a null exit retains evidence.
    if (confirmedExit) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Unconfirmed fixture exit; retained ${root}`);
  }
});
