import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  isWriteOwnershipTraceEnabled,
  recordWriteOwnership,
  type WriteOwnershipRecord,
} from '../../../src/backend/write-ownership-trace';

test('write-ownership trace is env-gated and appends JSONL records with owner identity', () => {
  const previous = process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR;
  delete process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR;
  try {
    assert.equal(isWriteOwnershipTraceEnabled(), false);
    recordWriteOwnership({
      event: 'pie.write-ownership', ts: 1, pid: 1, seam: 'cold.truncateAfter',
      sessionPath: '/sessions/a.jsonl', ownerRole: 'coordinator',
    }); // must not throw and must not create files
  } finally {
    if (previous !== undefined) process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR = previous;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-write-ownership-trace-'));
  process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR = dir;
  try {
    assert.equal(isWriteOwnershipTraceEnabled(), true);
    recordWriteOwnership({
      event: 'pie.write-ownership', ts: 10, pid: process.pid, seam: '_appendEntry',
      sessionPath: '/sessions/a.jsonl', ownerRole: 'worker',
      workerId: 'worker-1', workerGeneration: 3, coordinatorGeneration: 1,
    });
    recordWriteOwnership({
      event: 'pie.write-ownership', ts: 20, pid: process.pid, seam: 'cold.truncateAfter',
      sessionPath: null, ownerRole: 'coordinator',
    });
    const fileName = `write-ownership-${process.pid}.jsonl`;
    const content = fs.readFileSync(path.join(dir, fileName), 'utf8');
    const records = content.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as WriteOwnershipRecord);
    assert.equal(records.length, 2);
    assert.equal(records[0]!.seam, '_appendEntry');
    assert.equal(records[0]!.ownerRole, 'worker');
    assert.equal(records[0]!.workerId, 'worker-1');
    assert.equal(records[0]!.workerGeneration, 3);
    assert.equal(records[1]!.ownerRole, 'coordinator');
    assert.equal(records[1]!.sessionPath, null);
  } finally {
    delete process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
