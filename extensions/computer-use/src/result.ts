import { readFile } from 'node:fs/promises';
import { MAX_OBSERVATION_BYTES, type RuntimeResponse } from './types.js';

export function truncateUtf8(text: string, maxBytes = MAX_OBSERVATION_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };
  const suffix = '\n[observation text truncated]';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  const source = Buffer.from(text);
  let end = budget;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return { text: source.subarray(0, end).toString('utf8') + suffix, truncated: true };
}

function line(label: string, value: unknown): string | null {
  return value === undefined ? null : `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
}

export function renderComputerText(action: string, result: RuntimeResponse): string {
  const rows = [
    `computer ${action}: ok`,
    line('session', result.sessionId), line('target', result.targetId), line('revision', result.revision),
    result.target ? line('target_metadata', result.target) : null,
    result.accessibilityAvailable === false ? 'accessibility_available: false' : null,
    result.degraded ? line('degraded', result.degraded) : null,
    result.held ? line('held', result.held) : null,
    result.cursor ? line('cursor', result.cursor) : null,
    result.state ? line('window_state', result.state) : null,
    result.displayImagePath ? `display_png: ${result.displayImagePath}` : null,
    result.imageWidth !== undefined && result.imageHeight !== undefined ? `display_size: ${result.imageWidth}x${result.imageHeight}` : null,
    result.fullImagePath ? `full_png: ${result.fullImagePath}` : null,
    result.fullImageWidth !== undefined && result.fullImageHeight !== undefined ? `full_png_size: ${result.fullImageWidth}x${result.fullImageHeight}` : null,
    result.sequencePath ? `sequence: ${result.sequencePath}` : null,
    result.tracePath ? `trace: ${result.tracePath}` : null,
    result.truncated ? 'observation_truncated: true' : null,
  ].filter((entry): entry is string => entry !== null);
  if (Array.isArray(result.elements) && result.elements.length > 0) {
    rows.push(`elements (${result.elements.length}):`);
    for (const raw of result.elements) {
      const e = raw as { ref?: string; role?: string; label?: string; frame?: unknown };
      rows.push(`  ${e.ref ?? '?'} ${e.role ?? 'element'} ${JSON.stringify(e.label ?? '')} ${JSON.stringify(e.frame ?? null)}`);
    }
  }
  if (result.tree) rows.push('tree:', result.tree);
  return truncateUtf8(rows.join('\n')).text;
}

export function modelAcceptsImages(model: unknown): boolean {
  const input = (model as { input?: unknown } | undefined)?.input;
  return Array.isArray(input) && input.includes('image');
}

export async function buildToolResult(action: string, result: RuntimeResponse, includeImage: boolean) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }> = [
    { type: 'text', text: renderComputerText(action, result) },
  ];
  if (includeImage && result.displayImagePath) {
    content.push({ type: 'image', data: (await readFile(result.displayImagePath)).toString('base64'), mimeType: 'image/png' });
  }
  const { elements, tree, displayImagePath, ...details } = result;
  return { content, details: { ...details, elementCount: elements?.length ?? 0 }, isError: false as const };
}

export function buildErrorResult(error: unknown) {
  const e = error as { code?: string; message?: string; retryable?: boolean; artifacts?: { sequencePath?: string; tracePath?: string } };
  const code = typeof e?.code === 'string' ? e.code : 'COMPUTER_ERROR';
  const message = typeof e?.message === 'string' ? e.message : String(error);
  return {
    content: [{ type: 'text' as const, text: truncateUtf8(`computer error [${code}]: ${message}`).text }],
    details: { error: { code, message, retryable: e?.retryable === true, ...(e?.artifacts ? { artifacts: e.artifacts } : {}) } },
    isError: true as const,
  };
}

export function buildToolError(error: unknown): Error {
  const result = buildErrorResult(error);
  const details = result.details.error;
  return Object.assign(new Error(result.content[0].text, { cause: error }), {
    name: 'ComputerToolError',
    code: details.code,
    retryable: details.retryable,
    ...(details.artifacts ? { artifacts: details.artifacts } : {}),
    details: result.details,
  });
}
