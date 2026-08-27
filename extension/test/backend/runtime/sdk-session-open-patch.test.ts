import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SDK_SESSION_OPEN_SINGLE_READ_MARKERS,
  hasSdkSessionOpenSingleReadMarkers,
  reverseSdkSessionOpenSingleRead,
  transformSdkSessionOpenSingleRead,
} from '../../../src/backend/sdk-session-open-patch';

const PRISTINE_SHAPE = `export class SessionManager {
    constructor(cwd, sessionDir, sessionFile, persist, newSessionOptions) {
        if (sessionFile) {
            this.setSessionFile(sessionFile);
        }
    }
    setSessionFile(sessionFile) {
        if (existsSync(this.sessionFile)) {
            this.fileEntries = loadEntriesFromFile(this.sessionFile);
        }
    }
    static open(path, sessionDir, cwdOverride) {
        const entries = loadEntriesFromFile(resolvedPath);
        return new SessionManager(cwd, dir, resolvedPath, true);
    }
}`;

test('single-read transform is deterministic, reversible, and idempotent', () => {
  const transformed = transformSdkSessionOpenSingleRead(PRISTINE_SHAPE);

  assert.equal(transformed.result, 'patched');
  assert.equal(hasSdkSessionOpenSingleReadMarkers(transformed.source), true);
  assert.equal(reverseSdkSessionOpenSingleRead(transformed.source), PRISTINE_SHAPE);
  assert.deepEqual(transformSdkSessionOpenSingleRead(transformed.source), {
    result: 'already-present',
    source: transformed.source,
  });
});

test('single-read transform rejects partial and ambiguous SDK shapes', () => {
  const partiallyPatched = PRISTINE_SHAPE.replace(
    '    setSessionFile(sessionFile) {',
    SDK_SESSION_OPEN_SINGLE_READ_MARKERS[2],
  );
  assert.deepEqual(transformSdkSessionOpenSingleRead(partiallyPatched), {
    result: 'unsupported-shape',
    source: partiallyPatched,
  });
  assert.equal(reverseSdkSessionOpenSingleRead(partiallyPatched), undefined);

  const duplicateConstructor = `${PRISTINE_SHAPE}\n${PRISTINE_SHAPE}`;
  assert.deepEqual(transformSdkSessionOpenSingleRead(duplicateConstructor), {
    result: 'unsupported-shape',
    source: duplicateConstructor,
  });
});

test('single-read reverse refuses incomplete marker sets', () => {
  const transformed = transformSdkSessionOpenSingleRead(PRISTINE_SHAPE);
  assert.equal(transformed.result, 'patched');
  const weakened = transformed.source.replace(
    '            this.setSessionFile(sessionFile, preloadedEntries);',
    '            this.setSessionFile(sessionFile, undefined); // preloadedEntries',
  );

  assert.equal(hasSdkSessionOpenSingleReadMarkers(weakened), false);
  assert.equal(reverseSdkSessionOpenSingleRead(weakened), undefined);
});
