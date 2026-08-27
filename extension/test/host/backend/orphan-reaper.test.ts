import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backendHostPid,
  isPieBackendCoordinator,
  parseWindowsProcessRecords,
} from '../../../src/host/backend/orphan-reaper';

test('parseWindowsProcessRecords accepts PowerShell single-object and array output', () => {
  assert.deepEqual(parseWindowsProcessRecords(JSON.stringify({
    ProcessId: 123,
    CommandLine: 'node C:\\pie\\out\\backend.js --hostPid 99',
    CreationDate: '20260826090000.000000+720',
  })), [{
    ProcessId: 123,
    CommandLine: 'node C:\\pie\\out\\backend.js --hostPid 99',
    CreationDate: '20260826090000.000000+720',
  }]);

  assert.deepEqual(parseWindowsProcessRecords(JSON.stringify([
    { ProcessId: 456, CommandLine: 'node,with,commas', CreationDate: null },
    { ProcessId: '789', CommandLine: null },
  ])), [
    { ProcessId: 456, CommandLine: 'node,with,commas', CreationDate: null },
    { ProcessId: 789, CommandLine: null, CreationDate: null },
  ]);
});

test('parseWindowsProcessRecords rejects malformed JSON and invalid process ids', () => {
  assert.deepEqual(parseWindowsProcessRecords('not json'), []);
  assert.deepEqual(parseWindowsProcessRecords(''), []);
  assert.deepEqual(parseWindowsProcessRecords(JSON.stringify([
    { ProcessId: 0, CommandLine: 'node' },
    { ProcessId: 'nan', CommandLine: 'node' },
    null,
  ])), []);
});

test('backend coordinator recognition is strict and supports quoted arguments', () => {
  const plain = 'node.exe C:\\extensions\\pie.pie-0.3.0\\out\\backend.js --sdkPath C:\\sdk --hostPid 123 --backendGeneration 4';
  const quoted = '"node.exe" "C:\\extensions\\pie.pie-0.3.0\\out\\backend.js" "--sdkPath" "C:\\sdk,path" "--hostPid" "456" "--backendGeneration" "7"';
  assert.equal(isPieBackendCoordinator(plain), true);
  assert.equal(isPieBackendCoordinator(quoted), true);
  assert.equal(backendHostPid(plain), 123);
  assert.equal(backendHostPid(quoted), 456);

  assert.equal(isPieBackendCoordinator('node.exe C:\\other\\backend.js --hostPid 123'), false);
  assert.equal(isPieBackendCoordinator('node.exe app.js --sdkPath C:\\sdk --hostPid 123 --backendGeneration 1'), false);
  assert.equal(backendHostPid('node backend.js --hostPid nope'), undefined);
});
