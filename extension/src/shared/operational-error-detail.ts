import type { OperationalErrorPayload } from './protocol';

/** Build the full diagnostic retained behind an operational notice's More control. */
export function formatOperationalErrorDetail(payload: OperationalErrorPayload): string {
  return [
    `Code: ${payload.code}`,
    ...(payload.detail?.trim() ? [payload.detail.trim()] : []),
    ...(payload.requestId?.trim() ? [`Request: ${payload.requestId.trim()}`] : []),
  ].join('\n');
}
