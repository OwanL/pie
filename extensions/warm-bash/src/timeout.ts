/**
 * Compute the effective timeout for a warm-bash command.
 *
 * - If the caller did not specify a timeout (or passed 0 / non-positive),
 *   apply the configured default so that simple commands can never inherit the
 *   upstream 600-second default and hang the session for 10 minutes.
 * - If the caller explicitly requested a timeout, honour it but cap it at
 *   maxTimeout so a runaway command cannot block indefinitely.
 */
export interface EffectiveTimeoutOpts {
  timeout: number | undefined;
  defaultTimeout: number;
  maxTimeout: number;
}

export function effectiveTimeout(opts: EffectiveTimeoutOpts): number {
  let t = opts.timeout ?? opts.defaultTimeout;
  if (Number.isNaN(t) || t <= 0) {
    t = opts.defaultTimeout;
  }
  if (t > opts.maxTimeout) {
    t = opts.maxTimeout;
  }
  return t;
}

/** Parse the env override for the default bash timeout (seconds). */
export function parseDefaultTimeout(raw: string | undefined, fallback: number, maxTimeout: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= maxTimeout) {
    return parsed;
  }
  return fallback;
}
