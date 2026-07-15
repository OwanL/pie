/**
 * ⚠️ ARCHIVED one-shot codemod — completed 2026-06-25.
 * Target refactor (protocol.ts split into shared/protocol/*) is DONE;
 * re-running OVERWRITES protocol.ts with a 1-line barrel (no backup, not
 * idempotent) and silently drops any missed export. Kept for history only.
 */
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync('extension/src/shared/protocol.ts', 'utf-8');
const lines = src.split('\n');

// Domain assignment for each export declaration
const domainMap = {
  PROTOCOL_VERSION: 'core',
  WEBVIEW_PROTOCOL_VERSION: 'core',
  assertProtocolVersion: 'core',
  RequestEnvelope: 'core',
  ResponseEnvelope: 'core',
  EventEnvelope: 'core',
  PatchOp: 'core',
  isEventEnvelope: 'core',
  isResponseEnvelope: 'core',
  ThinkingLevel: 'models',
  ModelSettings: 'models',
  ModelInputKind: 'models',
  ModelSubagentInfo: 'models',
  ModelInfo: 'models',
  ContextWindowUsage: 'models',
  AssistantUsage: 'models',
  FilesystemPathComposerInput: 'messages',
  ImageBlobComposerInput: 'messages',
  FileBlobComposerInput: 'messages',
  ComposerInput: 'messages',
  ComposerInputDraft: 'messages',
  UserContentTextPart: 'messages',
  UserContentImagePart: 'messages',
  UserContentPart: 'messages',
  ChatMessageTextPart: 'messages',
  ChatMessageReasoningPart: 'messages',
  ChatMessageToolCallPart: 'messages',
  ChatMessagePart: 'messages',
  ChatMessage: 'messages',
  CustomMessageDetails: 'messages',
  ToolCall: 'messages',
  SessionSummary: 'sessions',
  TranscriptPageDirection: 'sessions',
  TranscriptWindow: 'sessions',
  TranscriptPagePayload: 'sessions',
  SystemPromptSource: 'sessions',
  SystemPromptAvailability: 'sessions',
  SystemPromptEntry: 'sessions',
  SessionContextFileFactor: 'sessions',
  SessionToolSnippetFactor: 'sessions',
  SessionSkillFactor: 'sessions',
  SessionAnalyticsFactors: 'sessions',
  BackendReadyPayload: 'sessions',
  SessionOpenedPayload: 'sessions',
  SessionListChangedPayload: 'sessions',
  MessageStartedPayload: 'sessions',
  MessageDeltaPayload: 'sessions',
  MessageThinkingPayload: 'sessions',
  ToolStartedPayload: 'sessions',
  ToolFinishedPayload: 'sessions',
  CustomMessagePayload: 'sessions',
  ToolProgressPayload: 'sessions',
  MessageFinishedPayload: 'sessions',
  MessageAbortedPayload: 'sessions',
  BusyChangedPayload: 'sessions',
  ContextUsageChangedPayload: 'sessions',
  ErrorPayload: 'sessions',
  FileChangeKind: 'sessions',
  FileChangeEntry: 'sessions',
  ExtensionInfo: 'settings',
  PruningResult: 'settings',
  PruningDetails: 'settings',
  PruningMode: 'settings',
  PruningSettings: 'settings',
  PruningCatalog: 'settings',
  ChatPrefs: 'settings',
  PROVIDER_TOGGLES_ENV: 'settings',
  EXTENSION_TOGGLES_ENV: 'settings',
  ActiveRunStatus: 'settings',
  ActiveRunSummary: 'settings',
  RunOutcomeResolution: 'settings',
  RunOutcome: 'settings',
  DEFAULT_CHAT_PREFS: 'settings',
  DEFAULT_PRUNING_SETTINGS: 'settings',
  EMPTY_TRANSCRIPT_WINDOW: 'settings',
  resolveChatPrefs: 'settings',
  ExtensionUIMethod: 'webview',
  ExtensionUIRequestPayload: 'webview',
  ExtensionUIResponsePayload: 'webview',
  StateAppliedPayload: 'webview',
  ViewState: 'webview',
  HostToWebviewMessage: 'webview',
  WebviewToHostMessage: 'webview',
};

// Find where each export starts
const exportStarts = {};
for (const [name, domain] of Object.entries(domainMap)) {
  const regex = new RegExp(`^export (?:const|type|interface|function) ${name}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      exportStarts[name] = { line: i, domain };
      break;
    }
  }
}

// Sort exports by line number
const sorted = Object.entries(exportStarts).sort((a, b) => a[1].line - b[1].line);

// Assign each line to a domain
const lineToDomain = new Array(lines.length).fill(null);
for (let i = 0; i < sorted.length; i++) {
  const [name, info] = sorted[i];
  const start = info.line;
  const end = i + 1 < sorted.length ? sorted[i + 1][1].line : lines.length;
  for (let j = start; j < end; j++) {
    lineToDomain[j] = info.domain;
  }
}

// Also capture leading blank lines and JSDoc comments BEFORE each domain's first export
// by backtracking from the first export of each domain
const domainFirstLine = {};
for (const [name, info] of sorted) {
  if (!(info.domain in domainFirstLine) || info.line < domainFirstLine[info.domain]) {
    domainFirstLine[info.domain] = info.line;
  }
}

// Backtrack to include section comments
for (const [domain, firstLine] of Object.entries(domainFirstLine)) {
  let start = firstLine;
  // Backtrack past blank lines and comment blocks that precede this export
  while (start > 0) {
    const prev = lines[start - 1];
    if (prev === '' || prev.startsWith('//') || prev.startsWith('/**') || prev.startsWith(' *') || prev.startsWith(' */')) {
      start--;
    } else {
      break;
    }
  }
  for (let j = start; j < firstLine; j++) {
    lineToDomain[j] = domain;
  }
}

// Collect lines per domain
const domainLines = {};
for (const domain of new Set(Object.values(domainMap))) {
  domainLines[domain] = [];
}
for (let i = 0; i < lines.length; i++) {
  const domain = lineToDomain[i];
  if (domain) {
    domainLines[domain].push(lines[i]);
  }
}

// Identify cross-domain type references in each domain
const allTypeNames = Object.keys(domainMap);
const domainTypeNames = {};
for (const domain of Object.keys(domainLines)) {
  domainTypeNames[domain] = new Set();
}
for (const [name, domain] of Object.entries(domainMap)) {
  domainTypeNames[domain].add(name);
}

for (const [domain, dlines] of Object.entries(domainLines)) {
  const text = dlines.join('\n');
  for (const otherName of allTypeNames) {
    const otherDomain = domainMap[otherName];
    if (otherDomain === domain) continue;
    // Check if this domain references the other domain's type
    const regex = new RegExp(`\\b${otherName}\\b`);
    if (regex.test(text) && !domainTypeNames[domain].has(otherName)) {
      domainTypeNames[domain].add(otherName);
    }
  }
}

// Build import statements for each domain
const domainImports = {};
for (const [domain, typeNames] of Object.entries(domainTypeNames)) {
  const importsByDomain = {};
  for (const name of typeNames) {
    const fromDomain = domainMap[name];
    if (fromDomain && fromDomain !== domain) {
      if (!importsByDomain[fromDomain]) importsByDomain[fromDomain] = [];
      importsByDomain[fromDomain].push(name);
    }
  }
  const importLines = [];
  for (const [fromDomain, names] of Object.entries(importsByDomain)) {
    importLines.push(`import type { ${names.join(', ')} } from './${fromDomain}.js';`);
  }
  domainImports[domain] = importLines;
}

// Write files
const dir = 'extension/src/shared/protocol';
fs.mkdirSync(dir, { recursive: true });

for (const [domain, dlines] of Object.entries(domainLines)) {
  const imports = domainImports[domain] || [];
  const content = [...imports, '', ...dlines].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${domain}.ts`), content);
  console.log(`Wrote ${domain}.ts (${dlines.length} lines, ${imports.length} imports)`);
}

// Write index.ts
const indexContent = Object.keys(domainLines).map(d => `export * from './${d}.js';`).join('\n') + '\n';
fs.writeFileSync(path.join(dir, 'index.ts'), indexContent);
console.log('Wrote index.ts');

// Replace protocol.ts with barrel
const barrel = `// Re-export barrel — domain-specific imports available via './protocol/<domain>'\nexport * from './protocol/index.js';\n`;
fs.writeFileSync('extension/src/shared/protocol.ts', barrel);
console.log('Replaced protocol.ts with barrel');
