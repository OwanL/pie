import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readSessionMcpOverrides,
  sessionMcpConfigPathFor,
  sessionMcpOverridePath,
  writeSessionMcpOverrides,
} from '../mcp-session-config';

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
    },
    sessionOverrides: { jira: true },
  });
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { jira: true });
});

test('writeSessionMcpOverrides merges the agent-dir layer in (it is replaced by --mcp-config)', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      personal: { command: 'npx', args: ['personal-mcp'], env: { TOKEN: '${MY_TOKEN}' }, disabled: true },
    },
  }, null, 2));

  const { overridePath } = await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { echo: true } });
  const parsed = JSON.parse(await fs.readFile(overridePath, 'utf-8'));
  // The personal server definition must survive the layer swap, env ref intact
  // (interpolation happens in the adapter at load time, never in the artifact).
  assert.deepEqual(parsed.mcpServers.personal, { command: 'npx', args: ['personal-mcp'], env: { TOKEN: '${MY_TOKEN}' }, disabled: true });
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { echo: true });
  assert.deepEqual(parsed.mcpServers.echo, { disabled: true });
});

test('writeSessionMcpOverrides overlays disables on copied agent-dir entries', async (t) => {
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

test('legacy persisted false entries and copied disabled definitions are not session disables', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  await fs.writeFile(sessionMcpOverridePath(sessionPath), JSON.stringify({ mcpServers: {
    echo: { disabled: false }, jira: { disabled: true },
    personal: { command: 'node', disabled: true },
  } }));
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { jira: true });
});

test('enabling removes session disables without overriding copied agent-dir disables', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    personal: { command: 'node', disabled: true },
  } }));
  const { overridePath } = await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { personal: false, echo: true } });
  const parsed = JSON.parse(await fs.readFile(overridePath, 'utf8'));
  assert.deepEqual(parsed.mcpServers.personal, { command: 'node', disabled: true });
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { echo: true });
  assert.equal((await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { personal: false } })).removed, true);
});

test('startup removes legacy force-enables without expanding ambiguous copied definitions', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  const overridePath = sessionMcpOverridePath(sessionPath);
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  assert.equal(sessionMcpConfigPathFor(sessionPath), undefined);
  await fs.writeFile(overridePath, JSON.stringify({ mcpServers: {
    echo: { disabled: false }, jira: { disabled: true },
    personal: { command: 'node', disabled: false },
    ambiguous: { command: 'node', disabled: true },
  } }));
  assert.equal(sessionMcpConfigPathFor(sessionPath), overridePath);
  assert.deepEqual(JSON.parse(await fs.readFile(overridePath, 'utf8')).mcpServers, {
    jira: { disabled: true }, personal: { command: 'node' },
    ambiguous: { command: 'node', disabled: true },
  });
  assert.deepEqual(await readSessionMcpOverrides(sessionPath), { jira: true });
  await fs.writeFile(overridePath, JSON.stringify({ mcpServers: { echo: { disabled: false } } }));
  assert.equal(sessionMcpConfigPathFor(sessionPath), undefined);
  assert.equal(await readSessionMcpOverrides(sessionPath), null);
});

test('startup preserves modern copied agent-dir flags and rejects malformed artifacts', async (t) => {
  const agentDir = await makeTempProject();
  const sessionPath = path.join(agentDir, 'session.jsonl');
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    personal: { command: 'node', disabled: false },
  } }));
  const { overridePath } = await writeSessionMcpOverrides({ sessionPath, agentDir, overrides: { jira: true } });
  const before = await fs.readFile(overridePath, 'utf8');
  assert.equal(sessionMcpConfigPathFor(sessionPath), overridePath);
  assert.equal(await fs.readFile(overridePath, 'utf8'), before);
  await fs.writeFile(overridePath, 'not json');
  assert.throws(() => sessionMcpConfigPathFor(sessionPath));
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