const PI_INTRO =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';

const PIE_INTRO =
  'You are a coding agent operating inside pie, an extended harness built on pi and primarily surfaced through VS Code.';

const PI_DOCS_START = 'Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):';
const PI_DOCS_END = '- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)';

function promptPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/$/, '');
}

function extractBullet(block: string, label: string): string | undefined {
  const prefix = `- ${label}: `;
  const line = block.split('\n').find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

/**
 * Rebrand pi's default harness prompt for pie while preserving every dynamic
 * section built by pi (active tool snippets, tool guidelines, appended prompt,
 * project context, skills, date, and cwd). Unknown/custom prompt shapes are
 * deliberately left untouched.
 */
export function rewritePieHarnessPrompt(prompt: string, agentDir: string): string {
  if (!prompt.startsWith(PI_INTRO)) return prompt;

  let rewritten = PIE_INTRO + prompt.slice(PI_INTRO.length);
  const docsStart = rewritten.indexOf(PI_DOCS_START);
  if (docsStart < 0) return rewritten;

  const docsEndMarker = rewritten.indexOf(PI_DOCS_END, docsStart);
  if (docsEndMarker < 0) return rewritten;
  const docsEnd = docsEndMarker + PI_DOCS_END.length;
  const oldDocs = rewritten.slice(docsStart, docsEnd);

  const piReadme = extractBullet(oldDocs, 'Main documentation');
  const piDocs = extractBullet(oldDocs, 'Additional docs');
  const piExamples = extractBullet(oldDocs, 'Examples')?.replace(/ \(extensions, custom tools, SDK\)$/, '');
  if (!piReadme || !piDocs || !piExamples) return rewritten;

  const root = promptPath(agentDir);
  const pieDocs = `Harness documentation (read only when working on pie or its underlying pi runtime):
- Pie overview and docs index: ${root}/README.md; ${root}/docs/INDEX.md
- VS Code integration: ${root}/extension/README.md; host↔webview state contract: ${root}/docs/STATE_CONTRACT.md
- Custom capabilities: ${root}/extensions, ${root}/agents, ${root}/skills (read the relevant README.md or SKILL.md)
- Underlying pi: ${piReadme}; docs: ${piDocs}; examples: ${piExamples}
- For pi APIs, use the relevant docs/{extensions,skills,prompt-templates,tui,keybindings,sdk,custom-provider,models,packages}.md
- Read relevant docs completely and follow their cross-references before implementing.`;

  rewritten = rewritten.slice(0, docsStart) + pieDocs + rewritten.slice(docsEnd);
  return rewritten;
}
