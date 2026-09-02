import type { RenderFailurePayload } from '../../shared/protocol';
import type { TranscriptCommitTarget } from './transcript/commit-registry';

let latestRenderTarget: Pick<TranscriptCommitTarget, 'revision' | 'viewGeneration'> | null = null;
let latestRenderSurface: RenderFailurePayload['surface'] = 'unknown';

/** Protocol-sync metadata only. Error values and transcript content never enter it. */
export function recordRenderEvidenceTarget(
  target: Pick<TranscriptCommitTarget, 'revision' | 'viewGeneration'> | null,
  surface: RenderFailurePayload['surface'],
): void {
  latestRenderTarget = target;
  latestRenderSurface = surface;
}

export function recordRenderSurface(surface: RenderFailurePayload['surface']): void {
  latestRenderSurface = surface;
}

/** Builds the complete typed failure payload without accepting arbitrary data. */
export function sanitizedRenderFailure(
  classification: RenderFailurePayload['classification'],
  surface: RenderFailurePayload['surface'] = latestRenderSurface,
): RenderFailurePayload {
  return {
    viewGeneration: latestRenderTarget?.viewGeneration ?? 0,
    revision: latestRenderTarget?.revision ?? null,
    surface,
    classification,
  };
}

export interface SanitizedRenderDiagnostic {
  errorName?: string;
  errorMessage: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
}

const MAX_ERROR_NAME_CHARS = 128;
const MAX_ERROR_MESSAGE_CHARS = 512;
const MAX_ERROR_STACK_CHARS = 1_024;
const MAX_ERROR_SOURCE_CHARS = 256;

function readStringProperty(value: unknown, key: 'name' | 'message' | 'stack'): string | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function replaceLoneSurrogates(value: string): string {
  let normalized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        normalized += value[index] + value[index + 1];
        index += 1;
      } else {
        normalized += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      normalized += '\uFFFD';
    } else {
      normalized += value[index];
    }
  }
  return normalized;
}

function boundedDiagnosticText(value: string, maxChars: number, multiline = false): string {
  const inputWasTruncated = value.length > maxChars;
  const boundedInput = inputWasTruncated ? value.slice(0, maxChars) : value;
  const normalized = replaceLoneSurrogates(boundedInput)
    // eslint-disable-next-line no-control-regex -- intentionally replacing unsafe diagnostic controls
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD')
    .replace(multiline ? /\r\n?/g : /[\r\n]+/g, multiline ? '\n' : ' ')
    .trim();
  return !inputWasTruncated && normalized.length <= maxChars
    ? normalized
    : `${replaceLoneSurrogates(normalized.slice(0, maxChars - 1))}…`;
}

function boundedPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

/**
 * Retains enough bounded error detail to diagnose renderer failures without
 * forwarding arbitrary values. Query/fragment data is removed from the source
 * URL; the host logger applies its ordinary credential redaction to all fields.
 */
export function sanitizedRenderDiagnostic(
  error: unknown,
  metadata: { message?: unknown; source?: unknown; line?: unknown; column?: unknown } = {},
): SanitizedRenderDiagnostic {
  const rawName = readStringProperty(error, 'name');
  const rawMessage = readStringProperty(error, 'message')
    ?? (typeof error === 'string' ? error : undefined)
    ?? (typeof metadata.message === 'string' ? metadata.message : undefined)
    ?? 'Unknown renderer error';
  const rawStack = readStringProperty(error, 'stack');
  const rawSource = typeof metadata.source === 'string'
    ? metadata.source.replace(/[?#].*$/, '')
    : undefined;
  const line = boundedPositiveInteger(metadata.line);
  const column = boundedPositiveInteger(metadata.column);

  return {
    ...(rawName ? { errorName: boundedDiagnosticText(rawName, MAX_ERROR_NAME_CHARS) } : {}),
    errorMessage: boundedDiagnosticText(rawMessage, MAX_ERROR_MESSAGE_CHARS),
    ...(rawStack ? { stack: boundedDiagnosticText(rawStack, MAX_ERROR_STACK_CHARS, true) } : {}),
    ...(rawSource ? { source: boundedDiagnosticText(rawSource, MAX_ERROR_SOURCE_CHARS) } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/** Chromium reports these layout convergence notices through `window.error`. */
export function isBenignResizeObserverError(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  const normalized = message.trim().toLowerCase();
  return normalized === 'resizeobserver loop limit exceeded'
    || normalized === 'resizeobserver loop completed with undelivered notifications.';
}

/** Builds one bounded host-forwarded renderer diagnostic. */
export function sanitizedRenderLog(
  classification: RenderFailurePayload['classification'],
  scope: 'panel' | 'webview',
  diagnostic: SanitizedRenderDiagnostic,
  options: { fatal: boolean; benign?: boolean; level?: 'warn' | 'error' },
): {
  type: 'log';
  level: 'warn' | 'error';
  scope: 'panel' | 'webview';
  message: RenderFailurePayload['classification'];
  data: SanitizedRenderDiagnostic & { fatal: boolean; benign?: boolean };
} {
  return {
    type: 'log',
    level: options.level ?? 'error',
    scope,
    message: classification,
    data: {
      ...diagnostic,
      fatal: options.fatal,
      ...(options.benign === undefined ? {} : { benign: options.benign }),
    },
  };
}

/**
 * Preact Suspense signals a pending lazy component through the global error
 * hook as a thrown thenable. It is control flow, not a render failure.
 */
export function isSuspenseThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function';
}
