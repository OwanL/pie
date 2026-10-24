/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { useMemo } from 'preact/hooks';
import { cx } from '../lib/components/cx';
import { escapeMarkdownHtmlText } from './markdown-file-path';

// Independent of the full transcript renderer: previews need no highlighting,
// copy buttons, images, or interactive links/file paths.
const previewMarkdown = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    heading({ tokens }) {
      return `<p><strong>${this.parser.parseInline(tokens)}</strong></p>`;
    },
    link({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    image({ text }) {
      return escapeMarkdownHtmlText(text);
    },
  },
});

export function SubagentPreviewMarkdown({ text, class: className }: { text: string; class?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(previewMarkdown.parse(text) as string, {
    ALLOWED_TAGS: ['p', 'strong', 'em', 'del', 'code', 'pre', 'br', 'ul', 'ol', 'li', 'blockquote'],
    ALLOWED_ATTR: ['start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }), [text]);

  return <div class={cx('subagent-preview-markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
