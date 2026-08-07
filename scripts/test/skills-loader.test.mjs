import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSkills } from '../../extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillsDir = path.join(repoRoot, 'skills');

function repositorySkillFiles() {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name, 'SKILL.md'))
    .filter(existsSync)
    .sort();
}

test('the production Pi skill loader discovers all repository skills without diagnostics', () => {
  const result = loadSkills({
    cwd: repoRoot,
    agentDir: repoRoot,
    skillPaths: [skillsDir],
    includeDefaults: false,
  });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.skills.map((skill) => skill.filePath).sort(),
    repositorySkillFiles(),
  );

  for (const name of ['evaluate-sessions', 'develop-pie', 'diagnose']) {
    const skill = result.skills.find((candidate) => candidate.name === name);
    assert.ok(skill, `${name} should be discovered`);
    assert.equal(skill.disableModelInvocation, false, `${name} should be visible`);
  }
});
