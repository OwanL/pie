import { marked } from 'marked';

export interface CapturedSelectionForCopy {
  text: string;
  markdown: string;
}

const IGNORED_COPY_CLASSES = new Set(['code-block-header', 'code-block-toggle']);
const MARKDOWN_CONTEXT_TAGS = new Set([
  'PRE', 'CODE', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE', 'A',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
]);
const CODE_BLOCK_TOKEN_PREFIX = '\u0000PIE_CODE_BLOCK_';

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function shouldIgnoreElement(element: Element): boolean {
  return element.tagName === 'BUTTON'
    || element.tagName === 'SCRIPT'
    || element.tagName === 'STYLE'
    || element.getAttribute('aria-hidden') === 'true'
    || Array.from(IGNORED_COPY_CLASSES).some((className) => element.classList.contains(className));
}

function codeBlockToken(index: number): string {
  return `${CODE_BLOCK_TOKEN_PREFIX}${index}\u0000`;
}

function storeCodeBlock(text: string, codeBlocks: string[]): string {
  return codeBlockToken(codeBlocks.push(text) - 1);
}

function restoreCodeBlocks(text: string, codeBlocks: string[]): string {
  // eslint-disable-next-line no-control-regex -- Matches the private NUL-delimited tokens created above.
  return text.replace(/\u0000PIE_CODE_BLOCK_(\d+)\u0000/g, (token, index: string) => (
    codeBlocks[Number(index)] ?? token
  ));
}

function childNodesMarkdown(node: Node, codeBlocks: string[]): string {
  return Array.from(node.childNodes, (child) => markdownFromNode(child, codeBlocks)).join('');
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_{}\x5b\]()#+.!|>~-]/g, '\\$&');
}

function inlineCodeMarkdown(text: string): string {
  const delimiter = '`'.repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), ([ticks]) => ticks.length + 1)));
  const pad = text.startsWith(' ') || text.endsWith(' ') ? ' ' : '';
  return `${delimiter}${pad}${text}${pad}${delimiter}`;
}

function listMarkdown(element: Element, codeBlocks: string[], depth = 0): string {
  const ordered = element.tagName === 'OL';
  const startAttribute = ordered ? element.getAttribute('start') : null;
  const parsedStart = startAttribute === null ? 1 : Number(startAttribute);
  const start = Number.isInteger(parsedStart) ? parsedStart : 1;
  const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
  return items.map((item, index) => {
    const marker = ordered ? `${start + index}.` : '-';
    const nestedLists: string[] = [];
    const body = Array.from(item.childNodes).map((child) => {
      if (isElement(child) && (child.tagName === 'UL' || child.tagName === 'OL')) {
        nestedLists.push(listMarkdown(child, codeBlocks, depth + 1));
        return '';
      }
      return markdownFromNode(child, codeBlocks);
    }).join('').trim();
    const nested = nestedLists.length > 0
      ? `\n${nestedLists.map((list) => list.trimEnd()).join('\n')}`
      : '';
    return `${'  '.repeat(depth)}${marker} ${body}${nested}`;
  }).join('\n') + '\n\n';
}

function markdownFromNode(node: Node, codeBlocks: string[] = []): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.nodeValue ?? '');
  if (!isElement(node)) return childNodesMarkdown(node, codeBlocks);
  if (shouldIgnoreElement(node)) return '';

  const tag = node.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'HR') return '\n\n---\n\n';
  if (tag === 'PRE') {
    const code = node.querySelector('code');
    const language = code?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? '';
    const renderedText = code ? plainFromNode(code) : plainFromNode(node);
    const text = renderedText.endsWith('\n') ? renderedText.slice(0, -1) : renderedText;
    const fenceLength = Math.max(3, ...Array.from(text.matchAll(/`+/g), ([ticks]) => ticks.length + 1));
    const fence = '`'.repeat(fenceLength);
    const block = `${fence}${language}\n${text}\n${fence}`;
    return `\n\n${storeCodeBlock(block, codeBlocks)}\n\n`;
  }
  if (tag === 'CODE') return inlineCodeMarkdown(plainFromNode(node));
  if (tag === 'STRONG' || tag === 'B') return `**${childNodesMarkdown(node, codeBlocks)}**`;
  if (tag === 'EM' || tag === 'I') return `*${childNodesMarkdown(node, codeBlocks)}*`;
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return `~~${childNodesMarkdown(node, codeBlocks)}~~`;
  if (tag === 'A') {
    const label = childNodesMarkdown(node, codeBlocks);
    const href = node.getAttribute('href');
    return href ? `[${label}](${href.replace(/[\\()]/g, '\\$&')})` : label;
  }
  if (tag === 'UL' || tag === 'OL') return listMarkdown(node, codeBlocks);
  if (/^H[1-6]$/.test(tag)) {
    return `\n\n${'#'.repeat(Number(tag[1]))} ${childNodesMarkdown(node, codeBlocks).trim()}\n\n`;
  }
  if (tag === 'BLOCKQUOTE') {
    const content = childNodesMarkdown(node, codeBlocks).trim();
    return `\n\n${content.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')}\n\n`;
  }
  if (tag === 'TR') {
    const cells = Array.from(node.children)
      .filter((child) => child.tagName === 'TH' || child.tagName === 'TD')
      .map((cell) => childNodesMarkdown(cell, codeBlocks).trim());
    return `| ${cells.join(' | ')} |\n`;
  }
  if (tag === 'TABLE') {
    const rows = Array.from(node.querySelectorAll('tr')).filter((row) => row.closest('table') === node);
    if (rows.length === 0) return `\n\n${childNodesMarkdown(node, codeBlocks).trim()}\n\n`;
    const rowsMarkdown = rows.map((row, index) => {
      const cells = Array.from(row.children)
        .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
        .map((cell) => childNodesMarkdown(cell, codeBlocks).trim());
      const rowMarkdown = `| ${cells.join(' | ')} |\n`;
      return index === 0
        ? `${rowMarkdown}| ${cells.map(() => '---').join(' | ')} |\n`
        : rowMarkdown;
    }).join('');
    return `\n\n${rowsMarkdown}\n`;
  }
  if (tag === 'P') return `\n\n${childNodesMarkdown(node, codeBlocks).trim()}\n\n`;
  return childNodesMarkdown(node, codeBlocks);
}

function plainFromNode(node: Node, codeBlocks?: string[]): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (!isElement(node)) return Array.from(node.childNodes, (child) => plainFromNode(child, codeBlocks)).join('');
  if (shouldIgnoreElement(node)) return '';

  const tag = node.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'UL' || tag === 'OL') {
    const ordered = tag === 'OL';
    return Array.from(node.children).filter((child) => child.tagName === 'LI').map((item, index) => {
      const marker = ordered ? `${index + 1}.` : '•';
      return `${marker} ${plainFromNode(item, codeBlocks).trim()}`;
    }).join('\n') + '\n\n';
  }
  if (tag === 'TR') {
    return Array.from(node.children)
      .filter((child) => child.tagName === 'TH' || child.tagName === 'TD')
      .map((cell) => plainFromNode(cell, codeBlocks)).join('\t') + '\n';
  }
  if (tag === 'PRE') {
    const content = Array.from(node.childNodes, (child) => plainFromNode(child, codeBlocks)).join('');
    const readableCode = content.endsWith('\n') ? content.slice(0, -1) : content;
    return `${codeBlocks ? storeCodeBlock(readableCode, codeBlocks) : readableCode}\n\n`;
  }
  const content = Array.from(node.childNodes, (child) => plainFromNode(child, codeBlocks)).join('');
  if (tag === 'P' || /^H[1-6]$/.test(tag) || tag === 'BLOCKQUOTE' || tag === 'DIV' || tag === 'TR') {
    return `${content.trim()}\n\n`;
  }
  return content;
}

function normalizeReadableText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cloneSelectionWithMarkdownContext(range: Range): DocumentFragment {
  let fragment = range.cloneContents();
  for (let ancestor: Node | null = range.commonAncestorContainer; ancestor; ancestor = ancestor.parentNode) {
    if (!isElement(ancestor) || !MARKDOWN_CONTEXT_TAGS.has(ancestor.tagName)) continue;
    const wrapper = ancestor.cloneNode(false) as Element;
    wrapper.append(fragment);
    const wrappedFragment = wrapper.ownerDocument.createDocumentFragment();
    wrappedFragment.append(wrapper);
    fragment = wrappedFragment;
  }
  return fragment;
}

/** Turn rendered markdown back into a readable text-only clipboard value. */
export function markdownToReadableText(markdown: string): string {
  if (typeof document === 'undefined') return markdown;
  const detachedDocument = document.implementation.createHTMLDocument('');
  const root = detachedDocument.body;
  root.innerHTML = marked.parse(markdown, { async: false, breaks: true, gfm: true }) as string;
  const codeBlocks: string[] = [];
  return restoreCodeBlocks(normalizeReadableText(plainFromNode(root, codeBlocks)), codeBlocks);
}

/** Serialize a selected rendered fragment as Markdown, retaining formatting. */
export function selectionFragmentToMarkdown(fragment: DocumentFragment): string {
  const codeBlocks: string[] = [];
  const markdown = markdownFromNode(fragment, codeBlocks)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return restoreCodeBlocks(markdown, codeBlocks);
}

/** Capture both browser-visible plain text and Markdown for the current selection. */
export function captureSelectionForCopy(selection?: Selection | null): CapturedSelectionForCopy {
  const current = selection === undefined
    ? (typeof window === 'undefined' ? null : window.getSelection())
    : selection;
  if (!current || current.rangeCount === 0) return { text: '', markdown: '' };
  const text = current.toString();
  if (!text) return { text: '', markdown: '' };
  return {
    text,
    markdown: selectionFragmentToMarkdown(cloneSelectionWithMarkdownContext(current.getRangeAt(0))),
  };
}
