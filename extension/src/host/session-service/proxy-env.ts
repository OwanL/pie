import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { deriveApiKeyEnv } from '../../shared/protocol';

/**
 * Safe storage for proxied-provider upstream API keys.
 *
 * Each provider's upstream key lives in `proxy/.env` as `KEY=VALUE` (gitignored —
 * see proxy/.gitignore), referenced from `settings.json` `proxy.providers.<p>.apiKeyEnv`.
 * The LiteLLM proxy never sees the key on disk directly; the pie extension host
 * loads `proxy/.env` into `process.env` (see {@link loadProxyEnvIntoProcess}) before
 * spawning the proxy, so the child inherits the key via the normal env. This
 * mirrors the existing `UMANS_API_KEY` pattern (installer-set OS env for the
 * seed provider; `proxy/.env` is the user/agent/UI-managed extension of it).
 *
 * Safety properties:
 *   - Keys are NEVER written to `models.yaml`, `settings.json`, or any committed
 *     file — only to `proxy/.env` (gitignored) + `process.env` (in-memory).
 *   - `loadProxyEnvIntoProcess` never overrides an already-set env var, so an
 *     OS-installed key (e.g. `UMANS_API_KEY` at User scope) always wins over a
 *     stale `proxy/.env` entry.
 */

/** Resolve `proxy/.env` from PI_CODING_AGENT_DIR, or null when unset. */
export function resolveProxyEnvPath(): string | null {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return null;
  return path.join(agentDir, 'proxy', '.env');
}

/** Parse a single `KEY=VALUE` env line. Returns [key, value] or null for
 *  blank/comment/malformed lines. Strips a surrounding pair of single or double
 *  quotes from the value (matches `dotenv` behaviour for the common cases). */
function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null; // no key, or no '='
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!key) return null;
  return [key, value];
}

/** Read `proxy/.env` into a `Record<string,string>`. Returns {} when the file is
 *  absent or PI_CODING_AGENT_DIR is unset. Never throws. */
export async function readProxyEnv(): Promise<Record<string, string>> {
  const envPath = resolveProxyEnvPath();
  if (!envPath || !existsSync(envPath)) return {};
  try {
    const text = await fs.readFile(envPath, 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (parsed) out[parsed[0]] = parsed[1];
    }
    return out;
  } catch {
    return {};
  }
}

/** Load `proxy/.env` into `process.env`, WITHOUT overriding any var that is
 *  already set (an OS-installed key always wins over a stale .env entry).
 *  Returns the map of keys that were actually applied. Safe to call repeatedly
 *  (idempotent). Called on proxy startup (before the fail-loud env-var check)
 *  and after a UI/agent add so the proxy child inherits the new key. */
export async function loadProxyEnvIntoProcess(): Promise<Record<string, string>> {
  const env = await readProxyEnv();
  const applied: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      applied[k] = v;
    }
  }
  return applied;
}

/** Persist `KEY=value` to `proxy/.env` (updating an existing line in place, or
 *  appending a new one) and set `process.env[KEY]` immediately so the proxy
 *  child inherits it on the next (re)start. Creates `proxy/.env` (and the
 *  proxy dir) if absent. Throws if PI_CODING_AGENT_DIR is unset. */
export async function writeProxyEnvKey(key: string, value: string): Promise<void> {
  if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid proxy env key '${key}' (must be UPPER_SNAKE_CASE).`);
  }
  const envPath = resolveProxyEnvPath();
  if (!envPath) {
    throw new Error('PI_CODING_AGENT_DIR is not set; cannot write proxy/.env (set it to the pi config directory that contains settings.json).');
  }
  // Make sure the proxy dir exists (it should, but be resilient).
  await fs.mkdir(path.dirname(envPath), { recursive: true });

  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = (await fs.readFile(envPath, 'utf8')).split(/\r?\n/);
  }
  // Preserve a trailing-newline shape: drop a single trailing empty entry from
  // the split so we can re-append cleanly.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const quoted = value.includes('\n') || value.includes(' ') ? JSON.stringify(value) : value;
  const newLine = `${key}=${quoted}`;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseEnvLine(lines[i]);
    if (parsed && parsed[0] === key) {
      lines[i] = newLine;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(newLine);

  await fs.writeFile(envPath, lines.join('\n') + '\n', 'utf8');
  // Set in-process so the proxy child (re)started right after inherits the key.
  process.env[key] = value;
}

export { deriveApiKeyEnv };
