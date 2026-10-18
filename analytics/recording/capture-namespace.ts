import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

/** Scoped to the database, not to a host, workspace, or build. */
export const CANONICAL_CAPTURE_NAMESPACE = 'canonical';

interface Database {
  prepare(sql: string): { all(): Array<Record<string, unknown>>; get(): Record<string, unknown> };
  close(): void;
}

/** Inspect only the already resolved canonical path. Does not create or migrate
 * a database; normal recorder admission remains responsible for initialization.
 * This helper is deliberately not wired into authority selection yet. */
export function resolveCanonicalCaptureNamespace(databasePath: string): string {
  if (!isAbsolute(databasePath)) throw new Error('Canonical database path must be absolute.');
  try {
    if (!statSync(databasePath).isFile()) throw new Error('Canonical database path is not a file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return CANONICAL_CAPTURE_NAMESPACE;
    throw error;
  }
  const sqlite = createRequire(process.execPath)('node:sqlite') as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database;
  };
  const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number(database.prepare('PRAGMA user_version').get().user_version);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (version === 0 && tables.length === 0) return CANONICAL_CAPTURE_NAMESPACE;
    // Match the recorder's supported migration range, without running migrations.
    if (!Number.isInteger(version) || version < 1 || version > 15) {
      throw new Error(`Unsupported analytics database schema version ${version}.`);
    }
    // These are the persisted namespace sources used by the v3 migration. From
    // v3 onward the registry additionally retains namespaces after fact deletion.
    const sources = ['analytics_observations', 'analytics_detail_payloads'];
    if (version >= 3) sources.push('analytics_generations');
    const rows = database.prepare(sources.map((table) =>
      `SELECT generation_id FROM ${table}`).join(' UNION ')).all();
    if (rows.length === 0) return CANONICAL_CAPTURE_NAMESPACE;
    if (rows.length !== 1 || typeof rows[0].generation_id !== 'string' || !rows[0].generation_id.trim()) {
      throw new Error('Ambiguous or invalid analytics capture namespaces.');
    }
    return rows[0].generation_id;
  } finally {
    database.close();
  }
}
