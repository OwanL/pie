/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { highlightToolResultText } from '../highlight';

/**
 * Generic mixed text/image tool-result rendering (Phase 2 — computer-use
 * image-result foundation).
 *
 * pi tool results use the SDK's standard `{ content: [...] }` shape. Content
 * parts are recognized by `type`:
 *   - `{ type: 'text',  text }`
 *   - `{ type: 'image', data, mimeType }`   — `data` is raw base64 (no
 *     `data:` prefix), `mimeType` is e.g. `image/png`.
 *
 * When a result carries an image-typed part, the generic tool-call body routes
 * here instead of serializing the result as YAML. Image base64 is NEVER emitted
 * as text/YAML: it is only ever placed behind an `<img src="data:…">` so the
 * browser decodes it. Malformed or unsupported parts get a short, bounded
 * textual fallback that never dumps the part's raw bytes.
 */

/** A content part shaped like the SDK's `{ type, text }` / `{ type, data, mimeType }`. */
interface ToolResultContentPartLike {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

/** A recognized image MIME type: `image/<token>`. */
const IMAGE_MIME_RE = /^image\/[a-zA-Z0-9.+-]+$/;
/** Cap on a textual fallback so a malformed part never floods the DOM. */
const FALLBACK_MAX = 120;
/** Cap on an unknown `type` string echoed in a fallback. */
const TYPE_MAX = 40;

function asContentArray(result: unknown): unknown[] | null {
  // Reloaded transcript entries produced by the shared formatter may carry a
  // structured content array directly, while live SDK results use
  // `{ content: [...] }`. Accept both losslessly so live and replay rendering
  // cannot diverge or fall back to YAML/base64 output.
  if (Array.isArray(result)) return result;
  if (result == null || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? content : null;
}

/**
 * True when a result's `content` array contains any image-typed part. This is
 * the gate the body uses to take the mixed-content render path: any
 * `type: 'image'` part (even a malformed one) must NOT reach the YAML/text
 * serializer, because a present `data` field would leak base64.
 */
export function hasImageToolResult(result: unknown): boolean {
  const content = asContentArray(result);
  if (!content) return false;
  return content.some((part) => Boolean(part) && typeof part === 'object' && (part as ToolResultContentPartLike).type === 'image');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildDataUrl(part: ToolResultContentPartLike): string {
  return `data:${part.mimeType as string};base64,${part.data as string}`;
}

export interface ToolResultContentTextPart {
  kind: 'text';
  text: string;
}
export interface ToolResultContentImagePart {
  kind: 'image';
  /** `data:<mimeType>;base64,<data>` — the only place base64 is emitted. */
  src: string;
  /** Generic, bounded alt text (no user/base64 content). */
  alt: string;
}
export interface ToolResultContentUnsupportedPart {
  kind: 'unsupported';
  /** Bounded, data-free description of why the part was not rendered. */
  message: string;
}
export type ToolResultContentRenderPart =
  | ToolResultContentTextPart
  | ToolResultContentImagePart
  | ToolResultContentUnsupportedPart;

function classifyPart(part: unknown, index: number): ToolResultContentRenderPart {
  if (!part || typeof part !== 'object') {
    return { kind: 'unsupported', message: 'unsupported content part' };
  }
  const p = part as ToolResultContentPartLike;

  if (p.type === 'text') {
    if (typeof p.text === 'string') {
      return { kind: 'text', text: p.text };
    }
    return { kind: 'unsupported', message: 'unsupported text part: missing text' };
  }

  if (p.type === 'image') {
    const hasData = typeof p.data === 'string' && p.data.length > 0;
    const validMime = typeof p.mimeType === 'string' && IMAGE_MIME_RE.test(p.mimeType);
    if (hasData && validMime) {
      return { kind: 'image', src: buildDataUrl(p), alt: `Image result ${index + 1}` };
    }
    // Bounded, data-free reason — never echo the base64 payload.
    const reason = !hasData
      ? 'missing data'
      : typeof p.mimeType !== 'string'
        ? 'missing mimeType'
        : 'unsupported mimeType';
    return { kind: 'unsupported', message: `unsupported image part: ${reason}` };
  }

  const typeStr = typeof p.type === 'string' && p.type.length > 0 ? truncate(p.type, TYPE_MAX) : 'unknown';
  return { kind: 'unsupported', message: `unsupported content type: ${typeStr}` };
}

/**
 * Classify a result's `content` array into renderable parts (in source order).
 * Returns `null` when the result has no `content` array.
 */
export function classifyToolResultContent(result: unknown): ToolResultContentRenderPart[] | null {
  const content = asContentArray(result);
  if (!content) return null;
  return content.map((part, index) => classifyPart(part, index));
}

interface ToolResultContentPartsProps {
  result: unknown;
  /** Optional highlight language hint forwarded to text parts. */
  languageHint?: string;
}

/**
 * Render a result's `content` parts in order: text parts as highlighted code
 * blocks, image parts as bounded `<img>` data URLs, and anything else as a
 * bounded textual fallback. Image base64 appears only inside an `img src`.
 */
export function ToolResultContentParts({ result, languageHint }: ToolResultContentPartsProps) {
  const parts = classifyToolResultContent(result);
  if (!parts || parts.length === 0) {
    return <div class="tool-call-result-empty">(no content)</div>;
  }
  return (
    <div class="tool-call-result-content">
      {parts.map((part, index) => {
        if (part.kind === 'text') {
          return (
            <pre class="tool-call-pre tool-call-result-text hljs-scope" key={index}>
              <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(part.text, languageHint) }} />
            </pre>
          );
        }
        if (part.kind === 'image') {
          return <img class="tool-call-result-image" key={index} src={part.src} alt={part.alt} />;
        }
        return <div class="tool-call-result-unsupported" key={index}>{truncate(part.message, FALLBACK_MAX)}</div>;
      })}
    </div>
  );
}
