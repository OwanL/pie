import { marked } from 'marked';
import DOMPurify from 'dompurify';

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
 * Entry-count bound (rather than byte bound) keeps bookkeeping cheap; typical
 * markdown fragments are a few KB. The bound is sized for multi-session tab
 * switching: each host session switch swaps the visible transcript, and
 * without a resident cache every visible message of the newly-active session
 * re-parses (marked + per-code-block hljs.highlight + DOMPurify)
 * synchronously on the first frame — a blocking burst that holds the
 * `transcript-positioning` opacity mask up. 256 entries thrash across a
 * handful of active sessions (~5–8 × ~40 messages), re-parsing on every
 * back-and-forth; 512 keeps recent sessions resident so switching back to a
 * previously-viewed session renders from cache with no parse burst (memory
 * stays bounded at ~few MB for typical fragments). LRU refresh on hit keeps
 * the frequently-rendered visible fragments resident even as streaming
 * intermediate snapshots churn through the cache.
 */
const MARKDOWN_CACHE_MAX = 512;
const markdownCache = new LruCache<string, string>(MARKDOWN_CACHE_MAX);

/**
 * Reset the markdown render cache. Entries are content-addressed and always
 * valid, so production never needs to clear this — it exists for tests that
 * need a deterministic cache state.
 */
export function clearMarkdownCache(): void {
  markdownCache.clear();
}

/** Cache capacity, exported so tests can drive the eviction boundary exactly. */
export const MARKDOWN_CACHE_MAX_ENTRIES = MARKDOWN_CACHE_MAX;

/** Number of entries currently in the cache. Test-support / diagnostics. */
export function getMarkdownCacheSize(): number {
  return markdownCache.size;
}

export function renderMarkdown(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) {
    return cached;
  }

  const raw = marked.parse(text) as string;
  // Wrap GFM tables so they can scroll horizontally in a narrow sidebar.
  const withTableWrappers = raw
    .replace(/<table>/g, '<div class="md-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
  const html = DOMPurify.sanitize(withTableWrappers, { RETURN_DOM: false });
  markdownCache.set(text, html);
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
