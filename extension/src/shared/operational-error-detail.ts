import type { OperationalErrorPayload } from './protocol';

type OperationalErrorDetailSource = Pick<OperationalErrorPayload, 'code' | 'message' | 'sessionPath'>
  & Partial<Pick<OperationalErrorPayload, 'detail' | 'requestId'>>;

/** Build the full diagnostic retained behind an operational notice's More control. */
export function formatOperationalErrorDetail(payload: OperationalErrorDetailSource): string {
  return [
    `Code: ${payload.code}`,
    ...(payload.detail?.trim() ? [payload.detail.trim()] : []),
    ...(payload.requestId?.trim() ? [`Request: ${payload.requestId.trim()}`] : []),
  ].join('\n');
}
