import { createHash } from 'node:crypto';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}
