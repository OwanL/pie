/** Runtime switch shared by pie's backend and in-process extensions. */
export const AUTONOMOUS_MODE_ENV = 'PIE_AUTONOMOUS_MODE';
/** Per-root overrides mirrored to each isolated worker's runtime preferences. */
export const AUTONOMOUS_MODE_BY_SESSION_ENV = 'PIE_AUTONOMOUS_MODE_BY_SESSION_JSON';

/** Read the process-level autonomous-mode flag. */
export function isAutonomousModeEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[AUTONOMOUS_MODE_ENV] === '1';
}

/** Resolve the mode for the worker's root session, keeping the process-level
 * default as the fallback for old or partial runtime-preference snapshots. */
export function resolveAutonomousModeForSession(
  sessionPath: string,
  globalDefault: unknown,
  overrides: unknown,
): boolean {
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const override = (overrides as Record<string, unknown>)[sessionPath];
    if (typeof override === 'boolean') return override;
  }
  return typeof globalDefault === 'boolean' ? globalDefault : false;
}

/** Parse the optional environment mirror without treating malformed data as
 * an override; the caller then safely falls back to the shared global default. */
export function readAutonomousModeBySession(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, boolean> {
  const raw = env[AUTONOMOUS_MODE_BY_SESSION_ENV];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [path, enabled] of Object.entries(parsed as Record<string, unknown>)) {
      if (path && typeof enabled === 'boolean') result[path] = enabled;
    }
    return result;
  } catch {
    return {};
  }
}
