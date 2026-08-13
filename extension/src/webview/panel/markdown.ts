import { marked } from 'marked';
import DOMPurify from 'dompurify';

import {
  escapeMarkdownHtmlAttribute,
  escapeMarkdownHtmlText,
  isLocalFilePath,
  localFilePathReference,
  MARKDOWN_FILE_PATH_CLASS,
  MARKDOWN_FILE_PATH_ATTRIBUTE,
} from './markdown-file-path';
import { highlightCodeBlock } from './transcript/highlight';
import { LruCache } from './utils/lru-cache';

marked.setOptions({ breaks: true, gfm: true });

/** Code blocks taller than this are collapsed by default with a "show all" toggle. */
const LONG_CODE_LINE_THRESHOLD = 16;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

marked.use({
  renderer: {
    codespan({ text }) {
      const escapedText = escapeMarkdownHtmlText(text);
      if (!isLocalFilePath(text)) {
        return `<code>${escapedText}</code>`;
      }

      return `<code class="${MARKDOWN_FILE_PATH_CLASS}" ${MARKDOWN_FILE_PATH_ATTRIBUTE}="${escapeMarkdownHtmlAttribute(text)}" role="link" tabindex="0">${escapedText}</code>`;
    },
    link({ href, title, tokens }) {
      const pathReference = localFilePathReference(href);
      if (!pathReference) return false;

      const text = this.parser.parseInline(tokens);
      const titleAttribute = title ? ` title="${escapeMarkdownHtmlAttribute(title)}"` : '';
      return `<a href="${escapeMarkdownHtmlAttribute(href)}" class="${MARKDOWN_FILE_PATH_CLASS}" ${MARKDOWN_FILE_PATH_ATTRIBUTE}="${escapeMarkdownHtmlAttribute(pathReference)}" role="link" tabindex="0"${titleAttribute}>${text}</a>`;
    },
    code({ text, lang }: { text: string; lang?: string }) {
      const { html, language } = highlightCodeBlock(text, lang);
      const lineCount = text.split('\n').length;
      const collapsible = lineCount > LONG_CODE_LINE_THRESHOLD;
      const langLabel = language ?? (lang || '').trim().split(/\s+/)[0] ?? '';
      // `hljs-scope` on the wrapper scopes the shared hljs token theme
      // (styles/highlight.css) to this block. `language-X` is kept for
      // external tooling / copy semantics.
      const codeClass = `hljs${language ? ` language-${escapeHtml(language)}` : ''}`;
      const header =
        '<div class="code-block-header">' +
        `<span class="code-block-lang">${langLabel ? escapeHtml(langLabel) : ''}</span>` +
        '<button class="code-block-copy" type="button" aria-label="Copy code">Copy</button>' +
        '</div>';
      const toggle = collapsible
        ? `<button class="code-block-toggle" type="button" aria-expanded="false">Show all ${lineCount} lines</button>`
        : '';
      const wrapperClass = collapsible
        ? 'code-block code-block-collapsible code-block-collapsed hljs-scope'
        : 'code-block hljs-scope';
      return (
        `<div class="${wrapperClass}">` +
        header +
        `<pre><code class="${codeClass}">${html}</code></pre>` +
        toggle +
        '</div>'
      );
    },
  },
});

/**
 * Bounded LRU cache for rendered markdown. `renderMarkdown` is a pure
 * function of its input text (marked options + DOMPurify config are fixed at
 * module load), so output can be safely memoised by content. The host posts a
 * full `ViewState` ~7×/sec while streaming, and every `state` message gives
 * each message a fresh object reference — without this cache, every visible
 * message re-runs `marked.parse` + per-code-block `hljs.highlight` +
 * `DOMPurify.sanitize` on every snapshot (and again on every auto-expand /
 * tab-switch re-render), which is the dominant cost behind the UI's perceived
 * lag despite "just rendering text".
 *
 * Both entry count and estimated retained UTF-16 bytes are bounded. The byte
 * bound prevents a handful of unusually large tool results or growing stream
 * prefixes from retaining far more heap than the typical few-KB fragments.
 * The entry bound is sized for multi-session tab switching: each host session
 * switch swaps the visible transcript, and
 * without a resident cache every visible message of the newly-active session
 * re-parses (marked + per-code-block hljs.highlight + DOMPurify)
 * synchronously on the first frame — a blocking burst that holds the
 * `transcript-positioning` opacity mask up. 256 entries thrash across a
 * handful of active sessions (~5–8 × ~40 messages), re-parsing on every
 * back-and-forth; 512 keeps recent sessions resident so switching back to a
 * previously-viewed session renders from cache with no parse burst (memory
 * stays bounded at ~few MB for typical fragments). LRU refresh on hit keeps
 * frequently-rendered completed fragments resident. Streaming prefixes bypass
 * the cache entirely because each prefix is normally rendered only once.
 */
const MARKDOWN_CACHE_MAX = 512;
const MARKDOWN_CACHE_MAX_WEIGHT = 8 * 1024 * 1024;
const markdownCache = new LruCache<string, string>(MARKDOWN_CACHE_MAX, {
  maxWeight: MARKDOWN_CACHE_MAX_WEIGHT,
  // JavaScript strings are normally retained as UTF-16; this deliberately
  // conservative estimate counts both the source key and sanitized HTML value.
  weight: (text, html) => 2 * (text.length + html.length),
});

/** Cache bounds, exported so tests can drive the eviction boundary exactly. */
export const MARKDOWN_CACHE_MAX_ENTRIES = MARKDOWN_CACHE_MAX;
export const MARKDOWN_CACHE_MAX_BYTES = MARKDOWN_CACHE_MAX_WEIGHT;

function stripInteractiveFilePathMarkup(html: string): string {
  return html.replace(/<([a-z][\w:-]*)([^>]*\sdata-pie-file-path="[^"]*"[^>]*)>/gi, (_match, tag: string, attrs: string) => (
    `<${tag}${attrs
      .replace(/\sclass="file-path-link"/g, '')
      .replace(/\sdata-pie-file-path="[^"]*"/g, '')
      .replace(/\srole="link"/g, '')
      .replace(/\stabindex="0"/g, '')}>`
  ));
}

export function renderMarkdown(text: string, cache = true, interactiveFilePaths = true): string {
  // The same markdown can be rendered in an assistant reply and in a prompt or
  // user bubble. Keep those sanitized HTML variants in separate cache entries.
  const cacheKey = `${interactiveFilePaths ? 'paths' : 'plain'}:${text}`;
  if (cache) {
    const cached = markdownCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  const raw = marked.parse(text) as string;
  // Wrap GFM tables so they can scroll horizontally in a narrow sidebar.
  const withTableWrappers = raw
    .replace(/<table>/g, '<div class="md-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
  const sanitizedHtml = DOMPurify.sanitize(withTableWrappers, { RETURN_DOM: false });
  const html = interactiveFilePaths ? sanitizedHtml : stripInteractiveFilePathMarkup(sanitizedHtml);
  if (cache) markdownCache.set(cacheKey, html);
  return html;
}

export function reasoningSummary(text: string): string {
  const stripped = text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 80 ? stripped.slice(0, 80) + '...' : stripped;
}
