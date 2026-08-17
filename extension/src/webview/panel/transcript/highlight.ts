/**
 * Syntax highlighting + readable formatting for expanded tool calls and
 * markdown code blocks.
 *
 * Uses highlight.js with a small, explicitly-registered language set so the
 * bundle only carries the grammars we need. A bespoke theme that maps hljs
 * token classes onto the panel's `--panel-*` palette lives in
 * `styles/highlight.css` (applied via the `.hljs-scope` wrapper class), so
 * highlighting adapts to the panel theme without shipping a full hljs
 * stylesheet.
 *
 * Tool results from the pi SDK use a `{ content: [{ type: "text", text }] }`
 * shape (with optional `details`). `textFromToolResult` extracts the human-
 * readable text from that shape — used to render shell output as a live
 * streaming terminal pane instead of burying it inside JSON.
 */

import hljs from 'highlight.js/lib/core';
import yamlLang from 'highlight.js/lib/languages/yaml';
import jsonLang from 'highlight.js/lib/languages/json';
import bashLang from 'highlight.js/lib/languages/bash';
import javascriptLang from 'highlight.js/lib/languages/javascript';
import typescriptLang from 'highlight.js/lib/languages/typescript';
import pythonLang from 'highlight.js/lib/languages/python';
import diffLang from 'highlight.js/lib/languages/diff';
import cssLang from 'highlight.js/lib/languages/css';
import markdownLang from 'highlight.js/lib/languages/markdown';
import sqlLang from 'highlight.js/lib/languages/sql';
import xmlLang from 'highlight.js/lib/languages/xml';
import goLang from 'highlight.js/lib/languages/go';
import rustLang from 'highlight.js/lib/languages/rust';
import rubyLang from 'highlight.js/lib/languages/ruby';
import { stringify as stringifyYaml } from 'yaml';
import { stripAnsiEscapes } from '../../../shared/tool-call-analysis';

// Order matters: typescript extends javascript, so javascript must register
// first. Registering is idempotent.
hljs.registerLanguage('javascript', javascriptLang);
hljs.registerLanguage('typescript', typescriptLang);
hljs.registerLanguage('yaml', yamlLang);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bashLang);
hljs.registerLanguage('python', pythonLang);
hljs.registerLanguage('diff', diffLang);
hljs.registerLanguage('css', cssLang);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('sql', sqlLang);
hljs.registerLanguage('xml', xmlLang);
hljs.registerLanguage('go', goLang);
hljs.registerLanguage('rust', rustLang);
hljs.registerLanguage('ruby', rubyLang);

/** Aliases accepted from markdown fence info strings and file extensions. */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  diff: 'diff',
  patch: 'diff',
  css: 'css',
  scss: 'css',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  go: 'go',
  rs: 'rust',
};

/** Map a file extension (without leading dot) to a registered hljs language. */
function languageForExtension(ext: string): string | undefined {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return LANGUAGE_ALIASES[normalized];
}

/** Map a markdown fence info string (e.g. "ts", "python3") to a language id. */
function normalizeFenceLanguage(info: string): string | undefined {
  const raw = info.trim().split(/\s+/)[0] ?? '';
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? (hljs.getLanguage(lower) ? lower : undefined);
}

/** Infer a highlight language from a tool call's input file path, if present. */
export function languageForToolInput(toolName: string, input: unknown): string | undefined {
  const normalized = toolName.toLowerCase();
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const pathKeys = ['file_path', 'filePath', 'path', 'filename', 'fileName', 'targetFile', 'target_file'];
  for (const key of pathKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      const ext = value.split(/[\\/]/).pop() ?? '';
      const dot = ext.lastIndexOf('.');
      if (dot >= 0) {
        const lang = languageForExtension(ext.slice(dot + 1));
        if (lang) return lang;
      }
    }
  }
  // Tools that operate on a directory of code (grep/glob) can't pick one
  // language; leave undefined so the caller falls back to plain/JSON detect.
  void normalized;
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Highlight `code` for `language`, returning safe HTML with hljs token spans.
 *  Unknown/unregistered languages fall back to escaped plain text. */
export function highlight(code: string, language: string | undefined): string {
  if (!language) return escapeHtml(code);
  try {
    const resolved = hljs.getLanguage(language) ? language : LANGUAGE_ALIASES[language.toLowerCase()];
    if (resolved && hljs.getLanguage(resolved)) {
      return hljs.highlight(code, { language: resolved }).value;
    }
  } catch {
    // fall through to escaped plain text
  }
  return escapeHtml(code);
}

/** Highlight a markdown code block from its fence info string. Returns the
 *  language id that was used (for the `language-` class) plus the HTML. */
export function highlightCodeBlock(code: string, fenceInfo: string | undefined): { html: string; language: string | undefined } {
  const language = fenceInfo ? normalizeFenceLanguage(fenceInfo) : undefined;
  return { html: highlight(code, language), language };
}

/** True when `text` parses as a JSON object or array (not a bare scalar). */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Highlight a tool result's text content. Language is inferred deterministically:
 * an explicit hint (from the tool's file path) wins; otherwise JSON-shaped
 * output is highlighted as JSON; everything else is escaped plain text. We do
 * NOT auto-detect, to avoid false-positive highlighting on prose/log output.
 */
export function highlightToolResultText(text: string, languageHint?: string): string {
  if (languageHint) return highlight(text, languageHint);
  if (looksLikeJson(text)) return highlight(text, 'json');
  return escapeHtml(text);
}

export interface ToolResultContentPartLike {
  type?: string;
  text?: string;
}

/**
 * Extract concatenated text from a tool result's `content` parts (the SDK's
 * standard result shape). Returns `undefined` when there is no text content,
 * so callers can fall back to structured formatting.
 *
 * ANSI CSI escape sequences are stripped here so forced-color tool output
 * (e.g. `ls --color=always`, test runners with `--color`) renders as plain
 * text instead of leaking raw `\x1b[..m` codes. This is the single display
 * chokepoint for human-readable tool-result text, so all render paths
 * (terminal pane, error detail, activity tail) get clean text.
 */
export function textFromToolResult(result: unknown): string | undefined {
  if (result == null) {
    return undefined;
  }
  if (typeof result === 'string') {
    return stripAnsiEscapes(result) || undefined;
  }
  if (typeof result !== 'object') {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') {
    return stripAnsiEscapes(content) || undefined;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part): part is ToolResultContentPartLike =>
          Boolean(part) && typeof part === 'object',
      )
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('\n\n');
    const cleaned = stripAnsiEscapes(text);
    return cleaned || undefined;
  }
  return undefined;
}

/**
 * True when a result object carries nothing but `content` (+ `details`
 * metadata) — i.e. it is essentially plain text, not structured data worth
 * showing field-by-field as YAML.
 */
export function isTextOnlyToolResult(result: unknown): boolean {
  if (result == null || typeof result !== 'object') {
    return true;
  }
  const keys = Object.keys(result as Record<string, unknown>);
  if (keys.length === 0) {
    return true;
  }
  return keys.every((key) => key === 'content' || key === 'details');
}

/** Format an arbitrary value as highlighted YAML HTML. Strings render as-is. */
/** Serialize an arbitrary result value to the YAML text used for display. */
export function stringifyValueAsYamlText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    // lineWidth: 0 disables line wrapping so code/paths stay intact.
    return stringifyYaml(value, { indent: 2, lineWidth: 0 });
  } catch {
    // YAML serialization can fail (e.g. cycles); fall back to JSON, then String.
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}

export function formatValueAsHighlightedYaml(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  return highlight(stringifyValueAsYamlText(value), 'yaml');
}
