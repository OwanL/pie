import { redactSensitiveText } from './sensitive-redaction.js';

const INTERNAL_REQUEST_ID = /\breq-[A-Za-z0-9._:-]+\b/gi;
const UUID_IDENTITY = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LABELED_CORRELATION = /(\b(?:request|operation|turn|attempt|correlation)(?:[_ -]?id)?\s*[:=]\s*)(["']?)[A-Za-z0-9._:/-]+\2/gi;

/**
 * Renderer-boundary policy for operational text. Conversation content is not
 * passed through this function; it is limited to notices and transcript error
 * detail so user-authored IDs remain intact.
 */
export function redactRendererErrorText(value: string): string {
  return redactSensitiveText(value)
    .replace(INTERNAL_REQUEST_ID, 'request')
    .replace(UUID_IDENTITY, '[operation]')
    .replace(LABELED_CORRELATION, '$1[redacted]');
}
