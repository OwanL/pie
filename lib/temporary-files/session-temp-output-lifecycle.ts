/**
 * Durable session-tree ownership for temporary output files surfaced by the
 * pinned Pi SDK's OutputAccumulator (`pi-bash-<16 hex>.log`) and by Pie's
 * tool-result-pruner (`pruned-raw-<session>-<16 hex>.txt`).
 *
 * The worker records exact paths in memory and in one small sidecar manifest
 * per file. The coordinator consumes those manifests after worker retirement,
 * so a private close can retry cleanup even when a session_shutdown hook was
 * swallowed by the SDK or its worker process has already exited. No directory
 * family is swept: only files listed in a validated Pie-owned manifest qualify.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const REGISTRY_KEY = Symbol.for("pie.session-temp-output-lifecycle.v2");
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const SDK_OUTPUT_BASENAME = /^pi-bash-[0-9a-f]{16}\.log$/;
const PRUNED_RAW_BASENAME = /^pruned-raw-([A-Za-z0-9_-]+)-[0-9a-f]{16}\.txt$/;
const MANIFEST_PREFIX = "pie-session-temp-output-";
const MANIFEST_SUFFIX = ".json";

type TempOutputFamily = "sdk-output" | "pruned-raw";

type SessionOutputOwner = {
  readonly sessionId: string;
  readonly rootSessionId: string;
  closed: boolean;
  tail: Promise<void>;
};

type OwnedTempOutput = {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly path: string;
  readonly family: TempOutputFamily;
  readonly owner: SessionOutputOwner;
  readonly manifestPath?: string;
};

type SessionOutputRegistry = {
  filesBySession: Map<string, Map<string, OwnedTempOutput>>;
  ownersByObject: WeakMap<object, SessionOutputOwner>;
  ownersBySession: Map<string, Set<SessionOutputOwner>>;
  ownersByRoot: Map<string, Set<SessionOutputOwner>>;
};

type SessionTempOutputManifest = {
  version: 1;
  sessionId: string;
  rootSessionId: string;
  path: string;
  family: TempOutputFamily;
};

type FileSystemOperations = {
  lstat: typeof lstat;
  unlink: typeof unlink;
};

const defaultFileSystem: FileSystemOperations = { lstat, unlink };
let fileSystem: FileSystemOperations = defaultFileSystem;

/** Test seam for deterministic lstat/unlink failures. */
export function setSessionTempOutputFileSystemForTesting(
  operations: Partial<FileSystemOperations> | null,
): void {
  fileSystem = operations ? { ...defaultFileSystem, ...operations } : defaultFileSystem;
}

function sharedRegistry(): SessionOutputRegistry {
  const host = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = host[REGISTRY_KEY] as SessionOutputRegistry | undefined;
  if (existing) return existing;
  const created: SessionOutputRegistry = {
    filesBySession: new Map(),
    ownersByObject: new WeakMap(),
    ownersBySession: new Map(),
    ownersByRoot: new Map(),
  };
  host[REGISTRY_KEY] = created;
  return created;
}

function isSafeSessionId(sessionId: string | undefined | null): sessionId is string {
  return typeof sessionId === "string"
    && sessionId.length > 0
    && sessionId !== "unknown"
    && SAFE_SESSION_ID.test(sessionId);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function sdkOutputPath(candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) return undefined;
  let absolutePath: string;
  try {
    absolutePath = resolve(candidate);
  } catch {
    return undefined;
  }
  if (!SDK_OUTPUT_BASENAME.test(basename(absolutePath))) return undefined;
  if (!samePath(dirname(absolutePath), tmpdir())) return undefined;
  return absolutePath;
}

export function isSdkSessionTempOutputPath(candidate: unknown): boolean {
  return sdkOutputPath(candidate) !== undefined;
}

function prunedRawPath(
  candidate: unknown,
  sessionId: string,
  expectedTempDir: string,
): string | undefined {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) return undefined;
  let absolutePath: string;
  try {
    absolutePath = resolve(candidate);
  } catch {
    return undefined;
  }
  const match = PRUNED_RAW_BASENAME.exec(basename(absolutePath));
  if (!match || match[1] !== sessionId) return undefined;
  if (!samePath(dirname(absolutePath), expectedTempDir)) return undefined;
  return absolutePath;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function manifestPath(rootSessionId: string, outputPath: string): string {
  return join(tmpdir(), `${MANIFEST_PREFIX}${digest(rootSessionId)}-${digest(outputPath)}${MANIFEST_SUFFIX}`);
}

function manifestFor(output: OwnedTempOutput): SessionTempOutputManifest {
  return {
    version: 1,
    sessionId: output.sessionId,
    rootSessionId: output.rootSessionId,
    path: output.path,
    family: output.family,
  };
}

function addOwnerToIndex(index: Map<string, Set<SessionOutputOwner>>, key: string, owner: SessionOutputOwner): void {
  let owners = index.get(key);
  if (!owners) {
    owners = new Set();
    index.set(key, owners);
  }
  owners.add(owner);
}

function getOwnerState(
  sessionId: string,
  rootSessionId: string | undefined,
  ownerObject: object,
): SessionOutputOwner {
  const rootId = rootSessionId ?? sessionId;
  if (!isSafeSessionId(rootId)) throw new Error("Temporary output root session identity is missing or unsafe.");
  const registry = sharedRegistry();
  const prior = registry.ownersByObject.get(ownerObject);
  if (prior) {
    if (prior.sessionId !== sessionId || prior.rootSessionId !== rootId) {
      throw new Error("Temporary output lifecycle owner identity changed during a session.");
    }
    addOwnerToIndex(registry.ownersBySession, sessionId, prior);
    addOwnerToIndex(registry.ownersByRoot, rootId, prior);
    return prior;
  }

  const created: SessionOutputOwner = {
    sessionId,
    rootSessionId: rootId,
    closed: false,
    tail: Promise.resolve(),
  };
  registry.ownersByObject.set(ownerObject, created);
  addOwnerToIndex(registry.ownersBySession, sessionId, created);
  addOwnerToIndex(registry.ownersByRoot, rootId, created);
  return created;
}

function serializeOwner<T>(owner: SessionOutputOwner, operation: () => Promise<T>): Promise<T> {
  const result = owner.tail.then(operation, operation);
  owner.tail = result.then(() => undefined, () => undefined);
  return result;
}

function rememberOutput(output: OwnedTempOutput): OwnedTempOutput {
  const registry = sharedRegistry();
  let files = registry.filesBySession.get(output.sessionId);
  if (!files) {
    files = new Map();
    registry.filesBySession.set(output.sessionId, files);
  }
  const prior = files.get(output.path);
  if (prior) {
    if (prior.rootSessionId !== output.rootSessionId || prior.family !== output.family) {
      throw new Error("A temporary output path was reported by conflicting session owners.");
    }
    return prior;
  }
  const pathOwner = outputsFor((candidate) => samePath(candidate.path, output.path))[0];
  if (pathOwner) {
    if (pathOwner.owner !== output.owner
      || pathOwner.rootSessionId !== output.rootSessionId
      || pathOwner.family !== output.family) {
      throw new Error("A temporary output path was reported by conflicting session owners.");
    }
    return pathOwner;
  }
  files.set(output.path, output);
  return output;
}

async function writeManifest(output: OwnedTempOutput): Promise<void> {
  if (!output.manifestPath) return;
  const content = JSON.stringify(manifestFor(output));
  try {
    await writeFile(output.manifestPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
    const existingInfo = await fileSystem.lstat(output.manifestPath);
    if (!existingInfo.isFile()) throw new Error("Temporary output manifest path is not a regular file.");
    const existing = await readFile(output.manifestPath, "utf8");
    if (existing !== content) {
      throw new Error(`Temporary output manifest conflicts for ${basename(output.path)}.`);
    }
  }
}

async function pathIsAbsent(filePath: string): Promise<boolean> {
  try {
    await fileSystem.lstat(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return true;
    throw error;
  }
}

/** Remove only a regular file at its exact recorded path and verify absence. */
async function unlinkAndVerify(filePath: string): Promise<boolean> {
  let info;
  try {
    info = await fileSystem.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
    throw error;
  }
  // Never follow or remove a symlink substituted at a recorded output path.
  if (!info.isFile()) throw new Error(`Refusing to remove a non-file temporary output: ${basename(filePath)}.`);

  try {
    await fileSystem.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
  if (!(await pathIsAbsent(filePath))) {
    throw new Error(`Temporary output still exists after unlink: ${basename(filePath)}.`);
  }
  return true;
}

function removeOutputRecord(output: OwnedTempOutput): void {
  const registry = sharedRegistry();
  const files = registry.filesBySession.get(output.sessionId);
  files?.delete(output.path);
  if (files?.size === 0) registry.filesBySession.delete(output.sessionId);
  removeOwnerIfUnreferenced(output.owner);
}

function removeOwnerIfUnreferenced(owner: SessionOutputOwner): void {
  if (!owner.closed) return;
  const registry = sharedRegistry();
  for (const files of registry.filesBySession.values()) {
    if ([...files.values()].some((file) => file.owner === owner)) return;
  }
  for (const [index, key] of [
    [registry.ownersBySession, owner.sessionId],
    [registry.ownersByRoot, owner.rootSessionId],
  ] as const) {
    const owners = index.get(key);
    owners?.delete(owner);
    if (owners?.size === 0) index.delete(key);
  }
}

async function purgeOutput(output: OwnedTempOutput): Promise<boolean> {
  const removedFile = await unlinkAndVerify(output.path);
  if (output.manifestPath) await unlinkAndVerify(output.manifestPath);
  removeOutputRecord(output);
  return removedFile;
}

function outputsFor(
  predicate: (output: OwnedTempOutput) => boolean,
): OwnedTempOutput[] {
  const outputs: OwnedTempOutput[] = [];
  for (const files of sharedRegistry().filesBySession.values()) {
    for (const output of files.values()) {
      if (predicate(output)) outputs.push(output);
    }
  }
  return outputs;
}

async function purgeOutputs(outputs: readonly OwnedTempOutput[]): Promise<number> {
  let deleted = 0;
  const failures: string[] = [];
  for (const output of outputs) {
    try {
      if (await purgeOutput(output)) deleted++;
    } catch (error) {
      failures.push(`${basename(output.path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not purge ${failures.length} session-owned temporary output(s): ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ""}.`);
  }
  return deleted;
}

function outputRecord(
  sessionId: string,
  rootSessionId: string | undefined,
  owner: SessionOutputOwner,
  candidatePath: string,
  family: TempOutputFamily,
): OwnedTempOutput {
  return {
    sessionId,
    rootSessionId: rootSessionId ?? sessionId,
    path: candidatePath,
    family,
    owner,
    // Test stash directories may be redirected outside os.tmpdir(); those
    // outputs remain memory-owned but are intentionally not coordinator-visible.
    ...(samePath(dirname(candidatePath), tmpdir())
      ? { manifestPath: manifestPath(rootSessionId ?? sessionId, candidatePath) }
      : {}),
  };
}

/** Record an exact SDK OutputAccumulator path against its session owner. The
 *  owner object is the SDK sessionManager; its WeakMap lifecycle fence replaces
 *  the old arbitrary-size closed-ID cache, with no ID eviction race. */
export async function trackSessionTempOutput(
  sessionId: string | undefined | null,
  toolName: string,
  candidatePath: unknown,
  ownerObject: object,
  rootSessionId?: string,
): Promise<boolean> {
  if (!isSafeSessionId(sessionId) || toolName !== "bash") return false;
  const filePath = sdkOutputPath(candidatePath);
  if (!filePath) return false;
  return await trackOwnedPath(sessionId, rootSessionId, ownerObject, filePath, "sdk-output");
}

/** Record a pruner stash before writing it so a close fence cannot race a late
 *  write and leave raw output behind. `tmpDir` is normally os.tmpdir(); tests
 *  may redirect the stash and remain process-local. */
export async function createSessionTempOutput(
  sessionId: string | undefined | null,
  rootSessionId: string | undefined,
  ownerObject: object,
  candidatePath: unknown,
  write: () => Promise<void>,
  options: { tmpDir?: string } = {},
): Promise<boolean> {
  if (!isSafeSessionId(sessionId)) return false;
  const filePath = prunedRawPath(candidatePath, sessionId, options.tmpDir ?? tmpdir());
  if (!filePath) return false;
  const owner = getOwnerState(sessionId, rootSessionId, ownerObject);
  return await serializeOwner(owner, async () => {
    if (owner.closed) return false;
    const output = rememberOutput(outputRecord(sessionId, rootSessionId, owner, filePath, "pruned-raw"));
    await writeManifest(output);
    try {
      await write();
    } catch (error) {
      try {
        await purgeOutput(output);
      } catch (cleanupError) {
        throw new Error(`Pruner stash creation failed and its temporary output could not be reaped: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}.`, { cause: error });
      }
      throw error;
    }
    return true;
  });
}

async function trackOwnedPath(
  sessionId: string,
  rootSessionId: string | undefined,
  ownerObject: object,
  filePath: string,
  family: TempOutputFamily,
): Promise<boolean> {
  const owner = getOwnerState(sessionId, rootSessionId, ownerObject);
  return await serializeOwner(owner, async () => {
    const output = rememberOutput(outputRecord(sessionId, rootSessionId, owner, filePath, family));
    await writeManifest(output);
    if (owner.closed) await purgeOutput(output);
    return true;
  });
}

function markClosed(owners: Iterable<SessionOutputOwner>): SessionOutputOwner[] {
  const unique = [...new Set(owners)];
  for (const owner of unique) owner.closed = true;
  return unique;
}

/** Remove exact SDK/pruner outputs for one SDK session. A failed lstat, unlink,
 *  verification, or manifest removal rejects and keeps the corresponding
 *  ownership entry for retry. */
export async function cleanupSessionTempOutputs(
  sessionId: string | undefined | null,
  ownerObject?: object,
  rootSessionId?: string,
): Promise<number> {
  if (!isSafeSessionId(sessionId)) return 0;
  const registry = sharedRegistry();
  if (ownerObject) getOwnerState(sessionId, rootSessionId, ownerObject);
  let owners = [...(registry.ownersBySession.get(sessionId) ?? [])];
  if (owners.length === 0 && ownerObject) {
    owners = [getOwnerState(sessionId, rootSessionId, ownerObject)];
  }
  if (owners.length === 0) return 0;
  markClosed(owners);
  let deleted = 0;
  const failures: unknown[] = [];
  for (const owner of owners) {
    try {
      deleted += await serializeOwner(owner, () => purgeOutputs(outputsFor((output) => output.sessionId === sessionId && output.owner === owner)));
      removeOwnerIfUnreferenced(owner);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw combineFailures(`Could not purge temporary outputs for session ${sessionId}`, failures);
  return deleted;
}

/** Remove exact SDK/pruner outputs for a root session and all in-process child
 *  session owners attributed to it. Used by runtime teardown; the coordinator
 *  independently retries persisted manifests after process retirement. */
export async function cleanupSessionTempOutputTree(rootSessionId: string): Promise<number> {
  if (!isSafeSessionId(rootSessionId)) throw new Error("Temporary output root session identity is missing or unsafe.");
  const registry = sharedRegistry();
  const owners = markClosed(registry.ownersByRoot.get(rootSessionId) ?? []);
  const outputs = outputsFor((output) => output.rootSessionId === rootSessionId);
  const allOwners = [...new Set([...owners, ...outputs.map((output) => output.owner)])];
  let deleted = 0;
  const failures: unknown[] = [];
  for (const owner of allOwners) {
    try {
      deleted += await serializeOwner(owner, () => purgeOutputs(outputsFor((output) => output.rootSessionId === rootSessionId && output.owner === owner)));
      removeOwnerIfUnreferenced(owner);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw combineFailures(`Could not purge temporary outputs for root session ${rootSessionId}`, failures);
  return deleted;
}

/** Worker-process exit cleanup for every exact output the process owns. */
export async function cleanupAllSessionTempOutputs(): Promise<number> {
  const roots = new Set<string>();
  for (const output of outputsFor(() => true)) roots.add(output.rootSessionId);
  let deleted = 0;
  const failures: unknown[] = [];
  for (const rootSessionId of roots) {
    try {
      deleted += await cleanupSessionTempOutputTree(rootSessionId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw combineFailures("Could not purge all worker-owned temporary outputs", failures);
  return deleted;
}

function combineFailures(message: string, failures: readonly unknown[]): Error {
  const first = failures[0];
  const detail = failures.map((error) => error instanceof Error ? error.message : String(error)).slice(0, 5).join("; ");
  return new Error(`${message}: ${detail}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ""}.`, { cause: first });
}

function isManifest(value: unknown): value is SessionTempOutputManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && isSafeSessionId(record.sessionId as string | undefined)
    && isSafeSessionId(record.rootSessionId as string | undefined)
    && typeof record.path === "string"
    && (record.family === "sdk-output" || record.family === "pruned-raw");
}

function validateManifestOutput(manifest: SessionTempOutputManifest, rootSessionId: string): OwnedTempOutput {
  if (manifest.rootSessionId !== rootSessionId) throw new Error("Temporary output manifest root identity mismatch.");
  const filePath = resolve(manifest.path);
  if (!samePath(dirname(filePath), tmpdir())) throw new Error("Temporary output manifest path is outside os.tmpdir().");
  const validPath = manifest.family === "sdk-output"
    ? sdkOutputPath(filePath)
    : prunedRawPath(filePath, manifest.sessionId, tmpdir());
  if (!validPath || !samePath(validPath, filePath)) throw new Error("Temporary output manifest path does not match an owned Pie temp-file family.");
  const expectedManifestPath = manifestPath(rootSessionId, filePath);
  return {
    sessionId: manifest.sessionId,
    rootSessionId,
    path: filePath,
    family: manifest.family,
    owner: { sessionId: manifest.sessionId, rootSessionId, closed: true, tail: Promise.resolve() },
    manifestPath: expectedManifestPath,
  };
}

/** Coordinator-side close cleanup. Reads only manifests with the requested
 *  root hash, validates each exact output path, deletes and verifies that path,
 *  then removes its manifest. Any failure is surfaced and leaves the manifest
 *  available for a later private-close retry. */
export async function cleanupSessionTempOutputManifests(rootSessionId: string): Promise<number> {
  if (!isSafeSessionId(rootSessionId)) throw new Error("Temporary output root session identity is missing or unsafe.");
  const prefix = `${MANIFEST_PREFIX}${digest(rootSessionId)}-`;
  let names: string[];
  try {
    names = await readdir(tmpdir());
  } catch (error) {
    throw new Error(`Could not inspect temporary-output ownership manifests: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
  }
  const targets = names.filter((name) => name.startsWith(prefix) && name.endsWith(MANIFEST_SUFFIX));
  let deleted = 0;
  const failures: string[] = [];
  for (const name of targets) {
    const sidecarPath = join(tmpdir(), name);
    try {
      const sidecarInfo = await fileSystem.lstat(sidecarPath);
      if (!sidecarInfo.isFile()) throw new Error("Ownership manifest is not a regular file.");
      const parsed: unknown = JSON.parse(await readFile(sidecarPath, "utf8"));
      if (!isManifest(parsed)) throw new Error("Ownership manifest contents are invalid.");
      const output = validateManifestOutput(parsed, rootSessionId);
      if (basename(output.manifestPath!) !== name) throw new Error("Ownership manifest filename does not match its contents.");
      if (await unlinkAndVerify(output.path)) deleted++;
      await unlinkAndVerify(sidecarPath);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not purge ${failures.length} coordinator-owned temporary output(s): ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ""}.`);
  }
  return deleted;
}
