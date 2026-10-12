import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { CapturedPricingFacts } from '../../../analytics/contracts/model-pricing-facts';
import { resolveProviderConfigPaths } from '../catalog/provider-config-paths';
import { buildProviderRuntimePricingFacts } from './pricing-facts';
import { readProviderRuntimeProjectionSync } from './store';
import type { ProviderRuntimeReference } from './contracts';

const marker = 'pie-provider-runtime-v1';
const prefixLimit = 64 * 1024;
const sdkMessagePrefix = /^\s*\{\s*"type"\s*:\s*"message"(?:\s*,|\s*\})/;
export type SessionPricingCapture =
  | { kind: 'legacy' }
  | { kind: 'managed'; facts: CapturedPricingFacts | undefined };

/** Read only the initial SDK NDJSON entries, never message content or whole history.
 * Unknown/corrupt prefixes fail closed; only a positively unmarked prefix uses legacy rates.
 */
export function readSessionPricingFacts(
  sessionPath: string,
  artifactDir?: string,
): SessionPricingCapture {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(sessionPath, 'r');
    const buffer = Buffer.alloc(prefixLimit);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const text = buffer.subarray(0, length).toString('utf8');
    const lines = text.split('\n');
    const incompleteFinalLine = length === prefixLimit ? lines.pop() : undefined;
    let reference: ProviderRuntimeReference | undefined;
    let complete = length < prefixLimit;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (sdkMessagePrefix.test(line)) { complete = true; break; }
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid prefix');
      if (entry.type === 'message') { complete = true; break; }
      if (entry.type !== 'custom' || entry.customType !== marker) continue;
      const data = entry.data as Record<string, unknown>;
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).length !== 2 || data.version !== 1
        || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('Invalid reference');
      if (reference && reference.sha256 !== data.sha256) throw new Error('Conflicting references');
      reference = { version: 1, sha256: data.sha256 };
      // Runtime references are written in the session header. A large first
      // message may fill the bounded prefix before its newline; the marker is
      // enough to classify the captured session as managed.
      complete = true;
    }
    // A bounded prefix can end inside the first SDK message. Its type-first
    // serialization is enough to establish a positively unmarked legacy file,
    // without parsing or retaining any message body bytes.
    if (!complete && incompleteFinalLine !== undefined && sdkMessagePrefix.test(incompleteFinalLine)) complete = true;
    if (!complete) throw new Error('Oversized prefix');
    if (!reference) return { kind: 'legacy' };
    const directory = artifactDir ?? join(resolveProviderConfigPaths({
      configDir: process.env.PIE_PROVIDER_CONFIG_DIR,
    }).configDir, 'provider-runtime');
    return { kind: 'managed', facts: buildProviderRuntimePricingFacts(readProviderRuntimeProjectionSync(directory, reference)) };
  } catch {
    return { kind: 'managed', facts: undefined };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
