import { normalizePathSeparators } from '../../shared/path-utils.js';

/** Attribute used by delegated transcript handlers for locally-openable paths. */
export const MARKDOWN_FILE_PATH_ATTRIBUTE = 'data-pie-file-path';
export const MARKDOWN_FILE_PATH_SELECTOR = `[${MARKDOWN_FILE_PATH_ATTRIBUTE}]`;
export const MARKDOWN_FILE_PATH_CLASS = 'file-path-link';

const EXTENSIONLESS_FILE_NAMES = new Set(['copying', 'dockerfile', 'license', 'makefile', 'notice']);

/**
 * Conventional dotfile basenames (after the leading dot). Separator-free
 * tokens are treated as dotfiles only when they name one of these;
 * CSS-class-looking tokens such as `.message-body` stay ordinary inline code.
 */
const CONVENTIONAL_DOTFILES = new Set([
  'gitignore', 'gitattributes', 'gitmodules', 'gitconfig', 'gitkeep', 'git-blame-ignore-revs',
  'dockerignore', 'dockerfile',
  'npmrc', 'npmignore', 'yarnrc', 'nvmrc', 'node-version', 'python-version', 'ruby-version',
  'env', 'envrc',
  'editorconfig', 'babelrc', 'eslintrc', 'eslintignore', 'eslintcache', 'prettierrc',
  'prettierignore', 'stylelintrc', 'jshintrc', 'jscsrc', 'flowconfig', 'markdownlintrc',
  'hgignore', 'hgrc', 'cvsignore', 'svnignore',
  'bashrc', 'bash_profile', 'bash_logout', 'profile', 'zshrc', 'zprofile', 'zshenv', 'zlogout',
  'vimrc', 'viminfo', 'gvimrc', 'inputrc', 'exports',
  'htaccess', 'htpasswd', 'mailmap', 'nojekyll', 'watchmanconfig',
]);

/**
 * Well-known file extensions accepted on separator-free filenames. Property
 * access (`response.ok`, `process.env`, `console.log`) in inline code must
 * not become a failed file open, so bare names need a recognized extension;
 * paths containing separators are explicit references and keep the looser
 * "any letter-bearing extension" rule.
 */
const KNOWN_FILE_EXTENSIONS = new Set([
  // Programming languages and tooling
  'asm', 'bash', 'bat', 'c', 'cc', 'cjs', 'clj', 'cljs', 'cmd', 'coffee', 'cpp', 'cr', 'cs',
  'cts', 'cxx', 'd', 'dart', 'ejs', 'elm', 'erl', 'ex', 'exs', 'fish', 'fs', 'fsi', 'go',
  'gradle', 'graphql', 'groovy', 'gql', 'h', 'hbs', 'hpp', 'hrl', 'hs', 'hxx', 'java', 'js',
  'jsx', 'kt', 'kts', 'lua', 'make', 'mjs', 'mk', 'ml', 'mli', 'mts', 'nim', 'php', 'pl',
  'pm', 'prisma', 'proto', 'ps1', 'psd1', 'psm1', 'pug', 'py', 'pyi', 'pyw', 'r', 'rb', 'rs',
  's', 'scala', 'sh', 'sol', 'sql', 'svelte', 'swift', 'thrift', 'ts', 'tsx', 'vue', 'zig',
  'zsh',
  // Web and markup
  'astro', 'css', 'dtd', 'htm', 'html', 'jade', 'less', 'sass', 'scss', 'styl', 'svg',
  'wasm', 'webmanifest', 'xhtml', 'xml', 'xsd', 'xsl', 'xslt',
  // Config and data
  'avro', 'cfg', 'conf', 'csv', 'db', 'db3', 'ics', 'ini', 'json', 'json5', 'jsonc', 'jsonl',
  'lock', 'mdb', 'ndjson', 'parquet', 'properties', 'sqlite', 'sqlite3', 'toml', 'tsv', 'vcf',
  'yaml', 'yml',
  // Documentation
  'adoc', 'asciidoc', 'bib', 'doc', 'docx', 'epub', 'markdown', 'md', 'mdx', 'mobi', 'odp',
  'ods', 'odt', 'org', 'pdf', 'ppt', 'pptx', 'rst', 'rtf', 'tex', 'txt', 'xls', 'xlsx',
  // Images and media
  'aac', 'avif', 'bmp', 'flac', 'gif', 'heic', 'ico', 'jpeg', 'jpg', 'm4a', 'm4v', 'mkv',
  'mov', 'mp3', 'mp4', 'ogg', 'png', 'tif', 'tiff', 'wav', 'webm', 'webp', 'wmv',
  // Archives, binaries, and build artifacts
  '7z', 'a', 'apk', 'bazel', 'bin', 'bz2', 'bzl', 'class', 'cmake', 'dat', 'deb', 'diff',
  'dll', 'dylib', 'ear', 'exe', 'gz', 'jar', 'nix', 'o', 'obj', 'patch', 'rar', 'rpm', 'so',
  'tar', 'war', 'xz', 'zip',
]);

function isAbsoluteFilePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('/')
    || value.startsWith('\\\\');
}

function filePathLeaf(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '');
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
}

function isFileLikeLeaf(value: string): boolean {
  const leaf = filePathLeaf(value);
  if (!leaf || leaf === '.' || leaf === '..') return false;
  if (EXTENSIONLESS_FILE_NAMES.has(leaf.toLowerCase())) return true;

  // Separator-free tokens are ambiguous with property access (`response.ok`)
  // and CSS selectors (`.message-body`), so bare names get a conservative
  // allowlist. Paths containing separators are explicit references and keep
  // the looser "any letter-bearing extension" rule.
  const bare = !value.includes('/') && !value.includes('\\');

  if (/^\.[^./\\]+$/.test(leaf)) {
    return !bare || CONVENTIONAL_DOTFILES.has(leaf.slice(1).toLowerCase());
  }

  const extension = /\.([A-Za-z0-9_-]{1,16})$/.exec(leaf)?.[1];
  // Require at least one letter in the extension so versions, decimals, and
  // IP addresses in ordinary prose/code do not become failed file opens.
  if (!extension || !/[A-Za-z]/.test(extension)) return false;
  if (!bare) return true;
  if (KNOWN_FILE_EXTENSIONS.has(extension.toLowerCase())) return true;

  // Multi-dot conventional dotfiles such as `.env.local` keep the dotfile
  // base as the leading segment after the dot.
  if (leaf.startsWith('.')) {
    const dotfileBase = leaf.split('.')[1]?.toLowerCase();
    if (dotfileBase && CONVENTIONAL_DOTFILES.has(dotfileBase)) return true;
  }
  return false;
}

function stripReferenceSuffix(value: string): string {
  const suffixStart = value.search(/[?#]/);
  if (suffixStart < 0) return value;

  // Only treat #/? as a markdown fragment/query when the prefix already looks
  // like a file. This preserves legal names such as `foo#1.md` and
  // `feature#1/docs.md`.
  const prefix = value.slice(0, suffixStart);
  return isFileLikeLeaf(prefix) ? prefix : value;
}

function decodeFileUri(value: string): string | null {
  if (!/^file:/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
    return parsed.host ? `//${parsed.host}${pathname}` : pathname;
  } catch {
    return null;
  }
}

/**
 * Return the filesystem reference represented by a markdown path, or null for
 * URLs, anchors, commands, and ordinary code strings. The reference is kept in
 * its user-facing separator style; resolution happens only when an action is
 * invoked.
 */
export function localFilePathReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withoutSuffix = stripReferenceSuffix(trimmed);
  if (!withoutSuffix) return null;

  const fileUriPath = decodeFileUri(withoutSuffix);
  if (fileUriPath) return fileUriPath;
  if (withoutSuffix.startsWith('#') || withoutSuffix.startsWith('//')) return null;

  // Check rooted filesystem paths before generic URI schemes so Windows drive
  // letters (`C:/...`) are not mistaken for a protocol.
  if (isAbsoluteFilePath(withoutSuffix)) return withoutSuffix;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutSuffix)) return null;

  // `./` and `../` are explicit local references even when the file has no
  // conventional extension. Bare directory-looking strings remain ordinary
  // inline code so code such as `npm run build` is never made interactive.
  if (/^(?:\.\.[\\/]|\.[\\/])/.test(withoutSuffix)) return withoutSuffix;
  if (withoutSuffix.includes('/') || withoutSuffix.includes('\\')) {
    return isFileLikeLeaf(withoutSuffix) ? withoutSuffix : null;
  }

  return isFileLikeLeaf(withoutSuffix) ? withoutSuffix : null;
}

export function isLocalFilePath(value: string): boolean {
  return localFilePathReference(value) !== null;
}

function normalizePath(value: string, separator: '/' | '\\'): string {
  const slashValue = normalizePathSeparators(value);
  const drivePrefix = /^[A-Za-z]:\//.test(slashValue) ? slashValue.slice(0, 3) : '';
  const uncPrefix = slashValue.startsWith('//') ? '//' : '';
  const rootPrefix = drivePrefix || uncPrefix || (slashValue.startsWith('/') ? '/' : '');
  const remainder = rootPrefix ? slashValue.slice(rootPrefix.length) : slashValue;
  const parts: string[] = [];

  for (const part of remainder.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!rootPrefix) parts.push(part);
      continue;
    }
    parts.push(part);
  }

  const joined = `${rootPrefix}${parts.join('/')}`;
  if (separator === '\\') return joined.replace(/\//g, '\\');
  return joined;
}

/** Resolve a markdown-local reference against the active session cwd. */
export function resolveLocalFilePath(reference: string, workingDirectory: string | null): string | null {
  const localReference = localFilePathReference(reference);
  if (!localReference) return null;

  const fileUriPath = decodeFileUri(stripReferenceSuffix(reference.trim()));
  if (fileUriPath) return normalizePath(fileUriPath, fileUriPath.includes('\\') ? '\\' : '/');
  if (isAbsoluteFilePath(localReference)) {
    return normalizePath(localReference, localReference.includes('\\') ? '\\' : '/');
  }
  if (!workingDirectory) return localReference;

  const separator: '/' | '\\' = workingDirectory.includes('\\') ? '\\' : '/';
  const base = workingDirectory.replace(/[\\/]+$/, '');
  const relative = localReference.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, '');
  return normalizePath(`${base}${separator}${relative}`, separator);
}

export function escapeMarkdownHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeMarkdownHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
