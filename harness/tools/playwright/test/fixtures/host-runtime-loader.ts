import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SourceArtifactSdkModule } from '../../../../agent-processes/lib/sdk-integration/sdk.js';
import { verifySdkRuntimeArtifactDescriptor } from '../../../../agent-processes/lib/sdk-integration/sdk-runtime-artifact.js';

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const receivedDescriptor: unknown = JSON.parse(process.argv[3] ?? 'null');
const sandboxArgument = process.argv[4];
const resultPath = process.argv[5];
if (!sandboxArgument || !path.isAbsolute(sandboxArgument) || !resultPath || !path.isAbsolute(resultPath)) {
  throw new Error('An absolute dedicated temporary sandbox and result path are required for the host runtime fixture.');
}
const sandbox = path.resolve(sandboxArgument);
if (path.dirname(path.resolve(resultPath)) !== sandbox) {
  throw new Error('The host runtime fixture result file must live directly in the sandbox.');
}
const sandboxRelativeToRepo = path.relative(repoRoot, sandbox);
if (sandbox === path.parse(sandbox).root || sandboxRelativeToRepo === ''
    || (!sandboxRelativeToRepo.startsWith('..') && !path.isAbsolute(sandboxRelativeToRepo))) {
  throw new Error('The host runtime fixture sandbox must be outside the repository.');
}

// The parent env must already keep private authorities away from real user
// data; the child fails closed when any of them escape the supplied sandbox.
for (const name of [
  'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR',
  'PIE_DATA_DIR', 'PSModuleAnalysisCachePath',
] as const) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`The child requires ${name} to be bound to its sandbox.`);
  const relative = path.relative(sandbox, path.resolve(value));
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} must stay inside the dedicated sandbox (received: ${value})`);
  }
}

// Importing the shared fixture independently binds this process to the same
// candidate graph. Its module validates that selection before this fixture
// imports any Pi runtime module.
const source = await import('../../../../agent-processes/lib/sdk-integration/test/source-fixture.js');
const backendTarget = {
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
};
assert.deepEqual(source.sourceBackendTarget, backendTarget,
  'the shared source descriptor must target this executing Node runtime');
const descriptor = await verifySdkRuntimeArtifactDescriptor(receivedDescriptor, backendTarget);
assert.equal(descriptor.artifactDir, source.sourceDescriptor.artifactDir,
  'the parent-selected descriptor must match this process independent shared-fixture selection');
assert.equal(descriptor.identity, source.sourceDescriptor.identity);
assert.deepEqual(descriptor.manifest, source.sourceDescriptor.manifest);

const profile = path.join(sandbox, 'profile');
const data = path.join(sandbox, 'data');
const cache = path.join(sandbox, 'cache');
const temporary = path.join(sandbox, 'tmp');
const cwd = path.join(sandbox, 'workspace');
const agentDir = path.join(sandbox, 'agent');
await Promise.all([
  profile, data, cache, temporary, cwd, agentDir,
  path.join(profile, 'AppData', 'Roaming'),
  path.join(profile, 'AppData', 'Local'),
  path.join(profile, '.config'),
  path.join(sandbox, 'ps-modules'),
  path.resolve(process.env['PI_CODING_AGENT_DIR'] ?? ''),
  path.resolve(process.env['PI_CODING_AGENT_AUTH_DIR'] ?? ''),
  path.resolve(process.env['PI_CODING_AGENT_SESSION_DIR'] ?? ''),
  path.resolve(process.env['PSModuleAnalysisCachePath'] ?? ''),
].map((directory) => mkdir(directory, { recursive: true })));

// Use only the public source-selected SDK entry point. DefaultResourceLoader
// performs the genuine extension discovery/import/registration path; no private
// loader substitute or SDK monkey-patching is involved.
const { loadSdk } = await import('../../../../agent-processes/lib/sdk-integration/sdk.js');
const sdk: SourceArtifactSdkModule = await loadSdk(descriptor.sdkPath, {
  mode: 'source-artifact',
  descriptor,
  backendTarget,
  surface: 'full',
});
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: sdk.SettingsManager.inMemory(),
  additionalExtensionPaths: [path.join(repoRoot, 'extensions', 'playwright', 'index.ts')],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await resourceLoader.reload();
const loaded = resourceLoader.getExtensions();
const registered = loaded.extensions.flatMap((extension) => [...extension.tools.values()])
  .find((tool) => tool.definition.name === 'playwright');
const schema = registered?.definition.parameters as unknown;

interface SerializedSchemaProperties {
  action?: { enum?: unknown };
  input?: { anyOf?: unknown };
}

function schemaProperties(value: unknown): SerializedSchemaProperties | undefined {
  return (value as { properties?: SerializedSchemaProperties } | undefined)?.properties;
}

const actionEnum = schemaProperties(schema)?.action?.enum as string[] | undefined;
const inputMembers = (schemaProperties(schema)?.input?.anyOf ?? []) as unknown[];
const inputKinds = inputMembers.map((member) => {
  const kind = (member as { properties?: { kind?: { type?: unknown; enum?: unknown } } }).properties?.kind;
  return { type: String(kind?.type), enumLength: Array.isArray(kind?.enum) ? kind.enum.length : 0 };
});

// This process also imports node:test through the shared source fixture (its
// after-hook rehash), which prints a default runner summary to stdout, so the
// result travels through the sandbox-owned result file instead of stdout.
writeFileSync(resultPath, `${JSON.stringify({
  errors: loaded.errors,
  found: registered !== undefined,
  serializedLength: schema ? JSON.stringify(schema).length : 0,
  hasConst: schema ? JSON.stringify(schema).includes('"const"') : false,
  actionEnum,
  inputKinds,
  artifactDir: descriptor.artifactDir,
  sdkPath: descriptor.sdkPath,
  identity: descriptor.identity,
  target: backendTarget,
})}\n`);