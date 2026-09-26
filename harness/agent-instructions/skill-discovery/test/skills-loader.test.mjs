import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, mkdtempSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSdkModule } from '../../../../scripts/lib/package-resolution.mjs';

const sdkModuleUrl = pathToFileURL(resolveSdkModule('@earendil-works/pi-coding-agent')).href;
const { loadSkills, DefaultResourceLoader } = await import(sdkModuleUrl);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// B3 relocated the authored skill bundles; the settings `skills` array points
// the SDK at the new location (agent-dir-relative).
const skillsDir = path.join(repoRoot, 'harness', 'agent-instructions', 'skills');

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

  for (const name of ['develop-pie', 'diagnose']) {
    const skill = result.skills.find((candidate) => candidate.name === name);
    assert.ok(skill, `${name} should be discovered`);
    assert.equal(skill.disableModelInvocation, false, `${name} should be visible`);
  }
});

test('the real SDK resource loader discovers the relocated skills through the settings skills array exactly once', async () => {
  // End-to-end discovery contract for the B3 move, exercised through the
  // pinned SDK's real SettingsManager → PackageManager → loadSkills pipeline
  // (not a simulated directory scan): a settings.json whose global `skills`
  // array registers `harness/agent-instructions/skills` resolves that path
  // relative to the agent directory and loads every bundle exactly once.
  // A junction mirrors the relocated bundles inside an isolated temp agent
  // dir so the production relative path resolution is what runs; the
  // tracked settings files are asserted to carry the same entry.
  const settings = JSON.parse(readFileSync(path.join(repoRoot, 'settings.json'), 'utf8'));
  assert.ok(
    settings.skills?.includes('harness/agent-instructions/skills'),
    'settings.json must register the relocated skills directory',
  );
  const defaults = JSON.parse(readFileSync(path.join(repoRoot, 'settings.defaults.json'), 'utf8'));
  assert.ok(
    defaults.skills?.includes('harness/agent-instructions/skills'),
    'settings.defaults.json must register the relocated skills directory',
  );

  const agentDir = mkdtempSync(path.join(tmpdir(), 'pie-skills-discovery-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'pie-skills-cwd-'));
  const mirrorSkills = path.join(agentDir, 'harness', 'agent-instructions', 'skills');
  mkdirSync(path.dirname(mirrorSkills), { recursive: true });
  symlinkSync(skillsDir, mirrorSkills, 'junction');
  writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ skills: ['harness/agent-instructions/skills'] }));

  const loader = new DefaultResourceLoader({ cwd, agentDir });
  // Construction starts asynchronous loading; an awaited reload guarantees
  // the settings-driven skill set is resolved before assertions.
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  const skillFiles = skills.map((skill) => skill.filePath);
  assert.deepEqual(diagnostics, []);
  const unique = new Set(skillFiles);
  assert.equal(unique.size, skillFiles.length, 'no skill bundle may be discovered twice');
  assert.equal(unique.size, repositorySkillFiles().length, 'every relocated bundle is discovered');
  for (const name of ['develop-pie', 'diagnose']) {
    assert.ok(skills.some((skill) => skill.name === name), `${name} must be discovered`);
  }
  // Reload again: the same catalog through the new paths (fresh/reloaded
  // processes agree; no stale pre-move discovery, no duplication).
  await loader.reload();
  const reloadedFiles = loader.getSkills().skills.map((skill) => skill.filePath);
  assert.deepEqual(reloadedFiles.sort(), [...unique].sort());
});