import * as fs from 'node:fs';
import * as path from 'node:path';

import { DeferredTriggerStore } from '../../src/host/deferred-triggers/store.js';

const [action, file, triggerId, sessionPath, barrierDir, childId] = process.argv.slice(2);
if (!action || !file || !triggerId || !sessionPath || !childId) {
  throw new Error('usage: <action> <file> <triggerId> <sessionPath> <barrierDir> <childId>');
}

function waitForRelease(): Promise<void> {
  if (!barrierDir) return Promise.resolve();
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(path.join(barrierDir, `ready-${childId}`), String(process.pid), 'utf8');
  const release = path.join(barrierDir, 'release');
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!fs.existsSync(release)) return;
      clearInterval(poll);
      resolve();
    }, 2);
  });
}

async function main(): Promise<void> {
  const store = new DeferredTriggerStore(file);
  if (action === 'claim-crash') {
    const claim = store.tryClaim(triggerId, sessionPath, childId, process.pid, 'process crash fixture');
    process.stdout.write(`${JSON.stringify({ pid: process.pid, claimed: claim !== undefined })}\n`);
    return;
  }

  await waitForRelease();
  const recovered = action === 'recover-and-deliver'
    ? store.recoverDeadOwnerClaims()
    : [];
  const claim = store.tryClaim(triggerId, sessionPath, childId, process.pid, 'process race fixture');
  if (claim) {
    store.markDispatchStarted(claim);
    // Durable witness for the synthetic dispatch callback. Only the atomic
    // claim winner may append it; completion models the correlated acceptance.
    fs.appendFileSync(`${file}.dispatch-witness.jsonl`, `${JSON.stringify({ triggerId, claimId: claim.claimId, pid: process.pid })}\n`, 'utf8');
    store.completeClaim(claim);
  }
  process.stdout.write(`${JSON.stringify({ pid: process.pid, recovered, claimed: claim !== undefined, dispatched: claim !== undefined })}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
