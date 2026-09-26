/** Runtime switch shared by pie's backend and in-process extensions. */
export const AUTONOMOUS_MODE_ENV = 'PIE_AUTONOMOUS_MODE';

/** Read the process-level autonomous-mode flag. */
export function isAutonomousModeEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[AUTONOMOUS_MODE_ENV] === '1';
}
