import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { findSubagentProfile, loadSubagentProfiles } from '../../../src/backend/subagent-profiles';

function makeAgentDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-subagent-profiles-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('loadSubagentProfiles parses YAML content and skips invalid profile entries', () => {
  const agentDir = makeAgentDir({
    'model-profiles.yaml': JSON.stringify({
      profiles: [
        { id: 'good', eligible: true },
        { id: 'disabled', eligible: 'yes', disabled_reason: '' },
        null,
        { id: '', eligible: true },
      ],
    }),
  });

  const profiles = loadSubagentProfiles(agentDir);
  assert.deepEqual(profiles.get('good'), { eligible: true });
  assert.deepEqual(profiles.get('disabled'), { eligible: false });
  assert.equal(profiles.size, 2);
});

test('loadSubagentProfiles keeps same-id profiles isolated by provider', () => {
  const agentDir = makeAgentDir({
    'model-profiles.yaml': JSON.stringify({
      profiles: [
        { provider: 'github-copilot', id: 'gpt-shared', eligible: false, disabled_reason: 'not vetted' },
        { provider: 'openai-codex', id: 'gpt-shared', eligible: true },
      ],
    }),
  });

  const profiles = loadSubagentProfiles(agentDir);
  assert.deepEqual(findSubagentProfile(profiles, 'github-copilot', 'gpt-shared'), {
    eligible: false,
    disabledReason: 'not vetted',
  });
  assert.deepEqual(findSubagentProfile(profiles, 'openai-codex', 'gpt-shared'), {
    eligible: true,
  });
  assert.equal(findSubagentProfile(profiles, 'other-provider', 'gpt-shared'), undefined);
});

test('loadSubagentProfiles prefers YAML over JSON and falls back to .yml when needed', () => {
  const yamlPreferredDir = makeAgentDir({
    'model-profiles.yaml': JSON.stringify({
      profiles: [{ id: 'from-yaml', eligible: true }],
    }),
    'model-profiles.json': JSON.stringify({
      profiles: [{ id: 'from-json', eligible: true }],
    }),
  });
  const yamlProfiles = loadSubagentProfiles(yamlPreferredDir);
  assert.ok(yamlProfiles.has('from-yaml'));
  assert.ok(!yamlProfiles.has('from-json'));

  const ymlFallbackDir = makeAgentDir({
    'model-profiles.yml': JSON.stringify({
      profiles: [{ id: 'from-yml', eligible: false }],
    }),
  });
  const ymlProfiles = loadSubagentProfiles(ymlFallbackDir);
  assert.deepEqual(ymlProfiles.get('from-yml'), { eligible: false });
});

test('loadSubagentProfiles tolerates malformed YAML without throwing', () => {
  const agentDir = makeAgentDir({ 'model-profiles.yaml': '::{ not valid yaml' });
  const profiles = loadSubagentProfiles(agentDir);
  assert.equal(profiles.size, 0);
});

test('loadSubagentProfiles falls back to JSON when no YAML exists', () => {
  const agentDir = makeAgentDir({
    'model-profiles.json': JSON.stringify({
      profiles: [
        { id: 'good', eligible: true },
        { id: 'bad', eligible: false, disabled_reason: 'incompatible API' },
      ],
    }),
  });
  const profiles = loadSubagentProfiles(agentDir);
  assert.deepEqual(profiles.get('good'), { eligible: true });
  assert.deepEqual(profiles.get('bad'), { eligible: false, disabledReason: 'incompatible API' });
});

test('loadSubagentProfiles returns an empty map for malformed JSON, empty agent dirs, and empty input paths', () => {
  const malformedDir = makeAgentDir({ 'model-profiles.json': '{ this is not json' });
  assert.equal(loadSubagentProfiles(malformedDir).size, 0);

  const missingDir = makeAgentDir({});
  assert.equal(loadSubagentProfiles(missingDir).size, 0);
  assert.equal(loadSubagentProfiles('').size, 0);
});

test('loadSubagentProfiles reuses cached maps until the file changes and clears cache when the file disappears', () => {
  const fileName = 'model-profiles.json';
  const agentDir = makeAgentDir({
    [fileName]: JSON.stringify({
      profiles: [{ id: 'cached', eligible: true }],
    }),
  });
  const filePath = path.join(agentDir, fileName);

  const first = loadSubagentProfiles(agentDir);
  const second = loadSubagentProfiles(agentDir);
  assert.equal(second, first);
  assert.equal(second.get('cached')?.eligible, true);

  fs.rmSync(filePath);
  const emptied = loadSubagentProfiles(agentDir);
  assert.equal(emptied.size, 0);

  fs.writeFileSync(filePath, JSON.stringify({
    profiles: [{ id: 'cached', eligible: false }],
  }));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);
  const reloaded = loadSubagentProfiles(agentDir);
  assert.deepEqual(reloaded.get('cached'), { eligible: false });
});

test('loadSubagentProfiles tolerates stat and read races without throwing', () => {
  const agentDir = makeAgentDir({
    'model-profiles.json': JSON.stringify({
      profiles: [{ id: 'race', eligible: true }],
    }),
  });

  // Remove the file to simulate a race where stat/read fail after resolve
  const filePath = path.join(agentDir, 'model-profiles.json');
  const backup = filePath + '.bak';
  fs.renameSync(filePath, backup);
  assert.equal(loadSubagentProfiles(agentDir).size, 0);

  // Restore and verify it works when file exists
  fs.renameSync(backup, filePath);
  assert.equal(loadSubagentProfiles(agentDir).size, 1);
});
