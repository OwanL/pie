import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DeferredTriggerStore,
  replayTriggers,
  type TriggerOp,
} from '../../../src/host/deferred-triggers/store.js';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxCli = path.join(extensionRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const childFixture = path.join(extensionRoot, 'test', 'fixtures', 'deferred-trigger-process-child.ts');
const SESSION = '/repo/watcher.jsonl';

interface ChildResult {
  pid: number;
  claimed: boolean;
  dispatched?: boolean;
  recovered?: string[];
}

function dispatchWitnesses(file: string, triggerId: string): unknown[] {
  const witnessFile = `${file}.dispatch-witness.jsonl`;
  if (!fs.existsSync(witnessFile)) return [];
  return fs.readFileSync(witnessFile, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { triggerId?: string })
    .filter((entry) => entry.triggerId === triggerId);
}

function register(id: string): TriggerOp {
  return {
    id,
    op: 'register',
    sessionPath: SESSION,
    triggers: [{ kind: 'session_finished' }],
    at: '2026-09-05T00:00:00.000Z',
  };
}

function runChild(
  action: 'claim-and-deliver' | 'claim-crash' | 'recover-and-deliver',
  file: string,
  triggerId: string,
  barrierDir: string,
  childId: string,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      tsxCli,
      childFixture,
      action,
      file,
      triggerId,
      SESSION,
      barrierDir,
      childId,
    ], { cwd: extensionRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`deferred-trigger child ${childId} failed (${code ?? signal}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ChildResult);
      } catch (error) {
        reject(new Error(`deferred-trigger child ${childId} returned invalid JSON: ${stdout}\n${stderr}\n${String(error)}`));
      }
    });
  });
}

async function releaseWhenReady(barrierDir: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ready = fs.existsSync(barrierDir)
      ? fs.readdirSync(barrierDir).filter((name) => name.startsWith('ready-')).length
      : 0;
    if (ready >= count) {
      fs.writeFileSync(path.join(barrierDir, 'release'), 'go', 'utf8');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${count} deferred-trigger child processes`);
}

async function raceChildren(
  action: 'claim-and-deliver' | 'recover-and-deliver',
  file: string,
  triggerId: string,
  barrierDir: string,
): Promise<ChildResult[]> {
  const children = [
    runChild(action, file, triggerId, barrierDir, 'host-a'),
    runChild(action, file, triggerId, barrierDir, 'host-b'),
  ];
  await releaseWhenReady(barrierDir, children.length);
  return await Promise.all(children);
}

test('two OS processes claim once, and two replacement processes recover one dead pre-dispatch owner once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-deferred-trigger-process-race-'));
  const file = path.join(root, 'deferred-triggers', 'triggers.jsonl');
  const store = new DeferredTriggerStore(file);
  try {
    store.append(register('race'));
    const claimRace = await raceChildren(
      'claim-and-deliver', file, 'race', path.join(root, 'claim-barrier'),
    );
    assert.equal(claimRace.filter((result) => result.claimed).length, 1);
    assert.equal(claimRace.filter((result) => result.dispatched).length, 1);
    assert.equal(dispatchWitnesses(file, 'race').length, 1);
    assert.equal(replayTriggers(store.readOps()).has('race'), false);
    assert.equal(store.readOps().filter((op) => op.id === 'race' && op.op === 'fire').length, 1);

    store.append(register('recover'));
    const crashed = await runChild(
      'claim-crash', file, 'recover', path.join(root, 'unused-barrier'), 'dead-host',
    );
    assert.equal(crashed.claimed, true);
    assert.notEqual(crashed.pid, process.pid);
    assert.equal(replayTriggers(store.readOps()).get('recover')?.claimOwnerPid, crashed.pid);

    const recoveryRace = await raceChildren(
      'recover-and-deliver', file, 'recover', path.join(root, 'recovery-barrier'),
    );
    assert.equal(recoveryRace.filter((result) => result.claimed).length, 1);
    assert.equal(recoveryRace.filter((result) => result.dispatched).length, 1);
    assert.equal(dispatchWitnesses(file, 'recover').length, 1);
    assert.equal(recoveryRace.flatMap((result) => result.recovered ?? []).filter((id) => id === 'recover').length >= 1, true);
    assert.equal(replayTriggers(store.readOps()).has('recover'), false);
    assert.equal(store.readOps().filter((op) => op.id === 'recover' && op.op === 'fire').length, 1);
    assert.ok(store.readOps().some((op) =>
      op.id === 'recover' && op.op === 'release' && op.recoveryState === 'dead-owner-recovered'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
