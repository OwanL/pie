/**
 * ⚠️ ARCHIVED one-shot codemod — completed 2026-06-25.
 * Target refactor (isObjectRecord rename) is DONE; re-running brace-counts
 * WITHOUT ignoring braces in strings/regex/templates/comments → silent
 * source corruption on edge cases. Kept for history only.
 */
import fs from 'node:fs';

const replacements = [
  {
    file: 'extension/src/host/core/file-change-derivation.ts',
    importPath: '../../shared/type-guards',
  },
  {
    file: 'extension/src/shared/tool-call-analysis/summary.ts',
    importPath: '../type-guards',
  },
  {
    file: 'extension/src/webview/panel/session-tabs/token-usage.ts',
    importPath: '../../../../shared/type-guards',
  },
  {
    file: 'extension/src/webview/panel/tool-call-summary.ts',
    importPath: '../../../../shared/type-guards',
  },
  {
    file: 'extension/src/webview/panel/transcript/pruning.ts',
    importPath: '../../../../shared/type-guards',
  },
  {
    file: 'extension/src/webview/panel/transcript/subagent.ts',
    importPath: '../../../../shared/type-guards',
  },
  {
    file: 'extension/src/webview/panel/transcript/tool-call-card.tsx',
    importPath: '../../../../shared/type-guards',
  },
];

for (const { file, importPath } of replacements) {
  let content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  // Find the isRecord function definition
  let startIdx = -1;
  let braceCount = 0;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^function isRecord\(/.test(lines[i])) {
      startIdx = i;
      braceCount = 0;
      for (let j = i; j < lines.length; j++) {
        for (const char of lines[j]) {
          if (char === '{') braceCount++;
          if (char === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIdx = j;
              break;
            }
          }
        }
        if (endIdx >= 0) break;
      }
      break;
    }
  }

  if (startIdx >= 0 && endIdx >= 0) {
    // Check if import already exists
    if (!content.includes(`from '${importPath}'`)) {
      const importLine = `import { isRecord } from '${importPath}';\n`;
      lines.splice(startIdx, endIdx - startIdx + 1, importLine);
    } else {
      lines.splice(startIdx, endIdx - startIdx + 1);
    }
    content = lines.join('\n');
    fs.writeFileSync(file, content);
    console.log(`Replaced isRecord in ${file}`);
  } else {
    console.log(`WARNING: Could not find isRecord in ${file}`);
  }
}
