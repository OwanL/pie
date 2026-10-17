import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { BuiltinRuntimeModelResolver, ProviderRuntimeReference, RuntimeEntryManager, RuntimeSnapshot } from './contracts';
import { immutable, validNativeModel } from './projection';
import { parseModelPricing } from '../pricing/pricing-core';
import { repairRejectedLegacyRuntimeRows } from './recovery';

const marker = 'pie-provider-runtime-v1';
const maxBytes = 4 * 1024 * 1024;
const failure = () => new Error('Invalid provider runtime artifact or reference');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function exact(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k));
}
function reference(value: unknown): ProviderRuntimeReference {
  if (!exact(value, ['version', 'sha256']) || value.version !== 1 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw failure();
  return { version: 1, sha256: value.sha256 };
}
function snapshot(value: unknown): RuntimeSnapshot {
  if (!exact(value, ['version', 'configRevision', 'models']) || value.version !== 1 || typeof value.configRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.configRevision) || !Array.isArray(value.models) || value.models.length > 10000) throw failure();
  const identities = new Set<string>();
  for (const row of value.models) {
    if (!exact(row, ['providerId', 'id', 'enabled', 'visible', 'subagentEligible', 'credential'], ['model', 'rejection', 'builtinHeaders', 'pricingFacts'])
      || typeof row.providerId !== 'string' || !row.providerId || typeof row.id !== 'string' || !row.id
      || !['enabled', 'visible', 'subagentEligible'].every(k => typeof row[k] === 'boolean')) throw failure();
    const identity = JSON.stringify([row.providerId, row.id]);
    if (identities.has(identity)) throw failure(); identities.add(identity);
    const c = row.credential;
    if (!exact(c, ['source'], ['name', 'scope']) || !['legacy', 'none', 'saved', 'environment', 'default'].includes(String(c.source))
      || (c.source === 'environment' ? typeof c.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) : Object.hasOwn(c, 'name'))
      || (Object.hasOwn(c, 'scope') && (c.source !== 'saved' || typeof c.scope !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.scope)))) throw failure();
    if (row.pricingFacts !== undefined) {
      const parsed = parseModelPricing(row.pricingFacts);
      if (!row.model || !parsed || JSON.stringify(parsed) !== JSON.stringify(row.pricingFacts)
        || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key =>
          (row.model as any).cost?.[key] !== (parsed as any)[key])) throw failure();
    }
    if (row.builtinHeaders !== undefined) {
      const proof = row.builtinHeaders;
      if (!row.model || !exact(proof, ['provider', 'id', 'sha256']) || proof.provider !== row.providerId
        || proof.id !== row.id || typeof proof.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sha256)) throw failure();
    }
    if (row.model !== undefined) {
      const m = row.model;
      if (row.rejection !== undefined || !exact(m, ['provider', 'id', 'name', 'api', 'baseUrl', 'input', 'reasoning', 'contextWindow', 'maxTokens', 'cost'], ['compat', 'thinkingLevelMap'])
        || !exact(m.cost, ['input', 'output', 'cacheRead', 'cacheWrite']) || !validNativeModel(m)
        || m.provider !== row.providerId || m.id !== row.id) throw failure();
    } else if (row.rejection !== 'unsupported-or-incomplete-runtime-model') throw failure();
  }
  return immutable(value as unknown as RuntimeSnapshot);
}
/** Reject lexical ancestors inside every Git checkout (including nested paths). */
async function checkGitParents(path: string): Promise<void> {
  let cursor = path;
  while (true) {
    try { await lstat(join(cursor, '.git')); throw failure(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
/** Resolve an already existing artifact directory without creating anything. */
async function existingArtifactDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw failure();
  await checkGitParents(path);
  const resolved = await realpath(path);
  await checkGitParents(resolved);
  return resolved;
}
/** Explicit absolute artifact directory, outside every Git checkout (including nested paths). */
async function artifactDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw failure();
  await checkGitParents(path);
  // Check the real existing ancestor too: a lexical path may traverse a link into a checkout.
  let ancestor = path;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(ancestor); if (parent === ancestor) throw e; ancestor = parent;
    }
  }
  await checkGitParents(ancestor);
  await mkdir(path, { recursive: true });
  const resolved = await realpath(path);
  await checkGitParents(resolved);
  return resolved;
}
/** Immutable content-addressed artifact; returns only a hash, never a path. */
export async function saveProviderRuntimeProjection(artifactDir: string, projection: RuntimeSnapshot): Promise<ProviderRuntimeReference> {
  const text = JSON.stringify(snapshot(JSON.parse(JSON.stringify(projection))));
  if (Buffer.byteLength(text) > maxBytes) throw failure();
  const ref = { version: 1 as const, sha256: hash(text) };
  const dir = await artifactDirectory(artifactDir);
  const target = join(dir, `${ref.sha256}.json`);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return immutable(ref);
}
export async function readProviderRuntimeProjection(artifactDir: string, supplied: ProviderRuntimeReference,
  resolveBuiltinModels?: BuiltinRuntimeModelResolver): Promise<RuntimeSnapshot> {
  const ref = reference(supplied);
  const path = join(await existingArtifactDirectory(artifactDir), `${ref.sha256}.json`);
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > maxBytes) throw failure();
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw failure();
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (hash(text) !== ref.sha256) throw failure();
    try { return repairRejectedLegacyRuntimeRows(snapshot(JSON.parse(text)), resolveBuiltinModels); } catch { throw failure(); }
  } finally { await file.close(); }
}
/** Synchronous accounting read uses the same bounded hash/schema validation as promotion.
 * It never creates directories or resolves credentials. */
export function readProviderRuntimeProjectionSync(artifactDir: string, supplied: ProviderRuntimeReference,
  resolveBuiltinModels?: BuiltinRuntimeModelResolver): RuntimeSnapshot {
  const ref = reference(supplied);
  if (!isAbsolute(artifactDir)) throw failure();
  const check = (path: string) => {
    let cursor = path;
    while (true) {
      try { lstatSync(join(cursor, '.git')); throw failure(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  };
  check(artifactDir);
  const directory = realpathSync(artifactDir);
  check(directory);
  const descriptor = openSync(join(directory, `${ref.sha256}.json`), 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw failure();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw failure();
    const text = buffer.subarray(0, length).toString('utf8');
    if (hash(text) !== ref.sha256) throw failure();
    try { return repairRejectedLegacyRuntimeRows(snapshot(JSON.parse(text)), resolveBuiltinModels); } catch { throw failure(); }
  } finally { closeSync(descriptor); }
}

/** Full entries, not active branch/session ID: duplicated sessions inherit the capture. */
export function readProviderRuntimeReference(manager: Pick<RuntimeEntryManager, 'getEntries'>): ProviderRuntimeReference | undefined {
  let result: ProviderRuntimeReference | undefined;
  for (const entry of manager.getEntries()) {
    if (entry.type !== 'custom' || entry.customType !== marker) continue;
    const next = reference(entry.data);
    if (result && result.sha256 !== next.sha256) throw failure();
    result = next;
  }
  return result && immutable(result);
}
export function appendProviderRuntimeReference(manager: RuntimeEntryManager, supplied: ProviderRuntimeReference): void {
  const ref = reference(supplied);
  const existing = readProviderRuntimeReference(manager);
  if (existing) { if (existing.sha256 !== ref.sha256) throw failure(); return; }
  manager.appendCustomEntry(marker, ref);
}
