import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readSessionMcpOverrides,
  sessionMcpOverridePath,
  writeSessionMcpOverrides,
} from '../../../src/backend/mcp-session-config';

async function makeTempProject(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pie-mcp-session-'));
}

test('sessionMcpOverridePath is a sibling artifact next to the durable session file', () => {
  const sessionPath = path.join('data', 'sessions', 'abc-123.jsonl');
  assert.equal(
    sessionMcpOverridePath(sessionPath),
    path.join('data', 'sessions', 'abc-123.mcp-overrides.json'),
  );
  // A path without an extension still yields a stable name.
  assert.equal(
    sessionMcpOverridePath(path.join('data', 'sessions', 'abc-123')),
    path.join('data', 'sessions', 'abc-123.mcp-overrides.json'),
  );
});

test('writeSessionMcpOverrides without an agent-dir config writes flag entries only', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));

  const { overridePath, removed } = await writeSessionMcpOverrides({
    sessionPath,
    agentDir,
    overrides: { jira: true, echo: false },
  });
  assert.equal(removed, false);
  assert.equal(overridePath, sessionMcpOverridePath(sessionPath));

  // Only flags — never a server definition or credential.
  const parsed = JSON.parse(await fs.readFile(overridePath, 'utf-8'));
  assert.deepEqual(parsed, {
    mcpServers: {
      jira: { disabled: true },
      echo: { disabled: false },
    },
  });
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { jira: true, echo: false });
});

test('writeSessionMcpOverrides merges the agent-dir layer in (it is replaced by --mcp-config)', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      personal: { command: 'npx', args: ['personal-mcp'], env: { TOKEN: '${MY_TOKEN}' } },
    },
  }, null, 2));

  const { overridePath } = await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { echo: true } });
  const parsed = JSON.parse(await fs.readFile(overridePath, 'utf-8'));
  // The personal server definition must survive the layer swap, env ref intact
  // (interpolation happens in the adapter at load time, never in the artifact).
  assert.deepEqual(parsed.mcpServers.personal, { command: 'npx', args: ['personal-mcp'], env: { TOKEN: '${MY_TOKEN}' } });
  assert.deepEqual(parsed.mcpServers.echo, { disabled: true });
});

test('writeSessionMcpOverrides overlays disables/enables on copied agent-dir entries', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: { personal: { command: 'npx', args: ['x'], disabled: false } },
  }, null, 2));

  const { overridePath } = await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { personal: true } });
  const parsed = JSON.parse(await fs.readFile(overridePath, 'utf-8'));
  assert.deepEqual(parsed.mcpServers.personal, { command: 'npx', args: ['x'], disabled: true });
});

test('writeSessionMcpOverrides fails loudly on an unparsable agent-dir config', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(agentDir, 'mcp.json'), '{ this is not json');
  await assert.rejects(
    () => writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { echo: true } }),
    /cannot parse/,
  );
});

test('writeSessionMcpOverrides with an empty set removes the artifact', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));

  await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { echo: true } });
  assert.ok(await fs.stat(sessionMcpOverridePath(sessionPath)).then(() => true, () => false));

  const { removed } = await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: {} });
  assert.equal(removed, true);
  assert.equal(await readSessionMcpOverrides(sessionPath), null);
  assert.equal(
    await fs.stat(sessionMcpOverridePath(sessionPath)).then(() => true, (error) => error.code),
    'ENOENT',
  );
});

test('readSessionMcpOverrides returns null for a missing or malformed artifact', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));

  assert.equal(await readSessionMcpOverrides(sessionPath), null);

  await fs.writeFile(sessionMcpOverridePath(sessionPath), 'not json at all');
  assert.equal(await readSessionMcpOverrides(sessionPath), null);

  // A malformed shape yields an empty set (no overrides).
  await fs.writeFile(sessionMcpOverridePath(sessionPath), JSON.stringify({ mcpServers: 'garbage' }));
  assert.equal(await readSessionMcpOverrides(sessionPath), null);
});