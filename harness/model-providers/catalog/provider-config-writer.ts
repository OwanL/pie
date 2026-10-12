// Isolated editor only: no production wiring, profile defaults or credential operations.
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  parseProviderConfig, parseProviderConfigDocument, providerConfigRevision,
  type ProviderConfig, type ProviderConfigDiagnostic,
} from './provider-config';

export type ProviderConfigEdit =
  | { op: 'set'; path: readonly (string | number)[]; value: unknown }
  | { op: 'delete'; path: readonly (string | number)[] };
export type ProviderConfigWriteIO = Pick<typeof fs, 'readFile' | 'mkdir' | 'open' | 'rename' | 'link' | 'unlink'>;
type Diagnostic = Omit<ProviderConfigDiagnostic, 'code'> & {
  code: ProviderConfigDiagnostic['code'] | 'invalid-edit' | 'write-failed';
};
export type ProviderConfigWriteResult = (
  | { status: 'saved'; revision: string; config: ProviderConfig }
  | { status: 'unchanged'; revision: string | null; config: ProviderConfig }
  | { status: 'conflict' | 'busy' }
  | { status: 'invalid' | 'unreadable' | 'error'; diagnostic: Diagnostic }
) & { cleanupWarning?: string };

const failed = (): ProviderConfigWriteResult => ({ status: 'error', diagnostic: {
  code: 'write-failed', message: 'Provider configuration could not be saved.',
} });
const invalidEdit = (): ProviderConfigWriteResult => ({ status: 'invalid', diagnostic: {
  code: 'invalid-edit', message: 'Provider configuration edit is invalid.',
} });
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;

/**
 * Cooperative writers serialize with an exclusive, never-reclaimed lock. Unrelated
 * editors can still race the final check/rename; this is not native mandatory locking.
 * First creation requires same-filesystem hard links; unsupported filesystems fail
 * safely, without a rename fallback that could overwrite a concurrently created file.
 */
export async function editProviderConfig(
  configPath: string,
  expectedRevision: string | null,
  edits: readonly ProviderConfigEdit[],
  options: { io?: Partial<ProviderConfigWriteIO> } = {},
): Promise<ProviderConfigWriteResult> {
  const io: ProviderConfigWriteIO = { ...fs, ...options.io };
  const read = async (): Promise<{ text: string | null; revision: string | null } | ProviderConfigWriteResult> => {
    try {
      const text = await io.readFile(configPath, 'utf8');
      return { text, revision: providerConfigRevision(text) };
    } catch (error) {
      if (codeIs(error, 'ENOENT')) return { text: null, revision: null };
      return { status: 'unreadable', diagnostic: {
        code: 'unreadable', message: 'Provider configuration could not be read.',
      } };
    }
  };
  if (!Array.isArray(edits) || edits.some(edit => !edit ||
    (edit.op !== 'set' && edit.op !== 'delete') || !Array.isArray(edit.path) ||
    edit.path.length === 0 || edit.path.some((part: unknown) =>
      typeof part === 'string' ? part.length === 0 :
        typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0))) return invalidEdit();

  const initial = await read();
  if ('status' in initial) return initial;
  if (initial.revision !== expectedRevision) return { status: 'conflict' };
  const parsed = parseProviderConfigDocument(initial.text ?? 'version: 1\nproviders: {}\n');
  if (parsed.status === 'invalid') return parsed;

  let serialized: string;
  let config: ProviderConfig;
  try {
    const document = parsed.document;
    for (const edit of edits) {
      if (edit.op === 'set') document.setIn(edit.path, edit.value);
      else document.deleteIn(edit.path);
    }
    // Check syntax/string-key compatibility as well as schema after editing.
    serialized = document.toString();
    const roundTrip = parseProviderConfig(serialized);
    if (roundTrip.status === 'invalid') return roundTrip;
    config = roundTrip.config;
    if (isDeepStrictEqual(config, parsed.config)) {
      return { status: 'unchanged', revision: initial.revision, config: parsed.config };
    }
  } catch {
    return invalidEdit();
  }

  const lockPath = `${configPath}.lock`;
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  let temp: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tempPath: string | undefined;
  let ownsTemp = false;
  let result: ProviderConfigWriteResult = failed();
  let cleanupFailed = false;
  try {
    // Only a validated, semantically changed edit may create parent directories.
    await io.mkdir(dirname(configPath), { recursive: true });
    try {
      lock = await io.open(lockPath, 'wx');
    } catch (error) {
      if (codeIs(error, 'EEXIST')) return { status: 'busy' };
      throw error;
    }
    const locked = await read();
    if ('status' in locked) result = locked;
    else if (locked.revision !== initial.revision) result = { status: 'conflict' };
    else {
      tempPath = join(dirname(configPath), `.${basename(configPath)}.${randomUUID()}.tmp`);
      temp = await io.open(tempPath, 'wx');
      ownsTemp = true;
      await temp.writeFile(serialized, 'utf8');
      await temp.sync();
      await temp.close();
      temp = undefined;
      // Last check is inside the lock and immediately precedes the commit.
      const current = await read();
      if ('status' in current) result = current;
      else if (current.revision !== initial.revision) result = { status: 'conflict' };
      else {
        try {
          if (initial.revision === null) await io.link(tempPath, configPath);
          else {
            await io.rename(tempPath, configPath);
            ownsTemp = false;
          }
          result = { status: 'saved', revision: providerConfigRevision(serialized), config };
        } catch (error) {
          if (initial.revision === null && codeIs(error, 'EEXIST')) result = { status: 'conflict' };
          else throw error;
        }
      }
    }
  } catch {
    result = failed();
  } finally {
    // Only close/unlink artifacts successfully opened by this invocation.
    if (temp) {
      try { await temp.close(); } catch { cleanupFailed = true; }
    }
    if (ownsTemp && tempPath) {
      try { await io.unlink(tempPath); } catch { cleanupFailed = true; }
    }
    if (lock) {
      try { await lock.close(); } catch { cleanupFailed = true; }
      try { await io.unlink(lockPath); } catch { cleanupFailed = true; }
    }
  }
  if (cleanupFailed) {
    result.cleanupWarning = result.status === 'saved'
      ? 'Provider configuration was saved, but temporary write artifacts could not be fully cleaned up.'
      : 'Temporary write artifacts could not be fully cleaned up.';
  }
  return result;
}
