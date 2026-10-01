import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { withPiRuntime } from '../lib/pi-runtime-context.mjs';
import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';

// Selection is explicit command transport, never an ambient environment pointer.
export function extractRuntimeArgs(argv, { allowSdkPath = false } = {}) {
  const args = [];
  let artifactDir;
  let sdkPath;
  let forwarding = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') forwarding = true;
    const flag = !forwarding && (arg === '--pi-runtime' || arg.startsWith('--pi-runtime='))
      ? '--pi-runtime'
      : !forwarding && allowSdkPath && (arg === '--sdk-path' || arg.startsWith('--sdk-path=')) ? '--sdk-path' : undefined;
    if (!flag) { args.push(arg); continue; }
    const value = arg === flag ? argv[++index] : arg.slice(flag.length + 1);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires an artifact path`);
    if (artifactDir !== undefined || sdkPath !== undefined) throw new Error('Specify only one Pi runtime selection');
    if (flag === '--pi-runtime') {
      if (!path.isAbsolute(value)) throw new Error('--pi-runtime requires an absolute artifact root');
      artifactDir = value;
    } else sdkPath = value;
  }
  return { args, artifactDir, sdkPath };
}

export function verificationChildEnv(env) {
  const result = { ...env };
  // A runner invoked from node:test is still a fresh test command, not a nested
  // test-isolation worker. Inheriting this marker silently skips its tests.
  delete result.NODE_TEST_CONTEXT;
  return result;
}

export function runtimeArgs(context) {
  return ['--pi-runtime', context.artifactDir];
}

export async function resolveRuntimeSelection(selection, dependencies = {}) {
  let artifactDir = selection.artifactDir;
  if (selection.sdkPath !== undefined) {
    const sdkPath = path.resolve(selection.sdkPath);
    const suffix = '/node_modules/@earendil-works/pi-coding-agent';
    const normalized = sdkPath.replaceAll('\\', '/');
    if (!(process.platform === 'win32' ? normalized.toLowerCase() : normalized).endsWith(suffix)) {
      throw new Error('--sdk-path must identify a verified materialized SDK package, not a workspace or installed baseline');
    }
    const verify = dependencies.verifyPiRuntimeArtifact ?? verifyPiRuntimeArtifact;
    const root = path.resolve(sdkPath, '../../..');
    await access(path.join(root, 'manifest.json'));
    const verified = await verify(root);
    if (await realpath(sdkPath) !== verified.sdkPath) {
      throw new Error('--sdk-path must identify the verified materialized SDK package');
    }
    artifactDir = verified.artifactDir;
  }
  if (artifactDir !== undefined) await access(path.join(artifactDir, 'manifest.json'));
  return { artifactDir };
}

export async function withVerificationRuntime(selection, signal, run, dependencies = {}) {
  const { artifactDir } = await resolveRuntimeSelection(selection, dependencies);
  const acquire = dependencies.withPiRuntime ?? withPiRuntime;
  return acquire({ artifactDir, signal }, async (context) => {
    const result = await run(context);
    // Runners must reject uncertain tree teardown; ordinary test failure is safe.
    context.confirmChildCompletion();
    return result;
  });
}
