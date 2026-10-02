import assert from 'node:assert/strict';
import test from 'node:test';

import { resolve } from 'node:path';

import { parseArgs } from '../backend-args.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

// SHAPE-ONLY synthetic descriptor: parseArgs must accept and forward a valid
// generation-local source artifact descriptor without any real SDK verification.
const sourceArtifactDescriptor = createSyntheticSourceTestSdkRuntime(resolve('/sdk')).descriptor;
const descriptorJson = JSON.stringify(sourceArtifactDescriptor);

test('parseArgs reads sdkPath/cwd plus the required source descriptor and errors when args are missing or invalid', () => {
  assert.deepEqual(parseArgs(['--sdkPath', '/sdk', '--cwd', '/repo', '--sourceArtifactDescriptor', descriptorJson]), {
    sdkPath: '/sdk', cwd: '/repo', backendGeneration: 1, sourceArtifactDescriptor,
  });
  assert.deepEqual(parseArgs(['--cwd', '/repo', '--sdkPath', '/sdk', '--sourceArtifactDescriptor', descriptorJson]), {
    sdkPath: '/sdk', cwd: '/repo', backendGeneration: 1, sourceArtifactDescriptor,
  });
  assert.deepEqual(parseArgs(['--sdkPath', '/sdk', '--cwd', '/repo', '--hostPid', '1234', '--sourceArtifactDescriptor', descriptorJson]), {
    sdkPath: '/sdk', cwd: '/repo', hostPid: 1234, backendGeneration: 1, sourceArtifactDescriptor,
  });
  assert.deepEqual(parseArgs(['--sdkPath', '/sdk', '--hostPid', 'not-a-pid', '--sourceArtifactDescriptor', descriptorJson]), {
    sdkPath: '/sdk', cwd: process.cwd(), backendGeneration: 1, sourceArtifactDescriptor,
  });
  assert.throws(() => parseArgs(['--cwd', '/repo']), /Missing required --sdkPath argument/);
  // The verified generation-local source artifact descriptor is required and may
  // only be supplied once, as well-formed JSON with a valid descriptor shape.
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--cwd', '/repo']),
    /Missing required --sourceArtifactDescriptor argument/,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor', descriptorJson, '--sourceArtifactDescriptor', descriptorJson]),
    /Duplicate --sourceArtifactDescriptor/,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor', 'not-json']),
    /Malformed JSON for --sourceArtifactDescriptor/,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor', JSON.stringify({ kind: 'source-artifact' })]),
    /Invalid --sourceArtifactDescriptor argument/,
  );
});