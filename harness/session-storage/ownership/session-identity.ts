import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface SessionIdentity {
  sessionId: string;
  identityFallback: boolean;
}

/** Deterministic normalized-path hash used only when the session header has no stable ID. */
export function sessionPathHash(sessionPath: string): string {
  let normalized = sessionPath.trim().replace(/\\/g, '/');
  const wasUnc = normalized.startsWith('//');
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (wasUnc) normalized = `/${normalized}`;
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    normalized = normalized.toLowerCase();
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

function readFirstNonEmptyLine(filePath: string): string | undefined {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.allocUnsafe(4096);
  let buffered = '';
  let totalBytes = 0;
  try {
    while (totalBytes < 1024 * 1024) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        buffered += decoder.end();
        const finalLine = buffered.trim();
        return finalLine || undefined;
      }
      totalBytes += bytesRead;
      buffered += decoder.write(chunk.subarray(0, bytesRead));
      let newlineIndex: number;
      while ((newlineIndex = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newlineIndex).trim();
        buffered = buffered.slice(newlineIndex + 1);
        if (line) return line;
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve the stable ID from the first non-empty session JSONL line. */
export function resolveSessionIdentity(sessionPath: string): SessionIdentity {
  try {
    const firstLine = readFirstNonEmptyLine(sessionPath);
    if (firstLine) {
      const header = JSON.parse(firstLine) as Record<string, unknown>;
      if (header.type === 'session' && typeof header.id === 'string' && header.id.trim()) {
        return { sessionId: header.id.trim(), identityFallback: false };
      }
    }
  } catch {
    // Missing, unreadable, or malformed headers use the deterministic fallback.
  }
  return { sessionId: sessionPathHash(sessionPath), identityFallback: true };
}
