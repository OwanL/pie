import type { SessionAnalyticsFactors } from '../../contracts/legacy-run-analytics-contracts.js';
import { isObjectRecord, coerceStringArray } from './coercion-utils';

function coerceContextFiles(value: unknown): SessionAnalyticsFactors['contextFiles'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObjectRecord)
    .map((entry) => ({
      path: typeof entry.path === 'string' ? entry.path : '',
      hash: typeof entry.hash === 'string' ? entry.hash : '',
    }))
    .filter((entry) => entry.path.length > 0 && entry.hash.length > 0);
}

function coerceToolSnippetHashes(value: unknown): SessionAnalyticsFactors['toolSnippetHashes'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObjectRecord)
    .map((entry) => ({
      toolId: typeof entry.toolId === 'string' ? entry.toolId : '',
      hash: typeof entry.hash === 'string' ? entry.hash : '',
    }))
    .filter((entry) => entry.toolId.length > 0 && entry.hash.length > 0);
}

function coerceSkills(value: unknown): SessionAnalyticsFactors['skills'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObjectRecord)
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : null,
      sourceHash: typeof entry.sourceHash === 'string' ? entry.sourceHash : null,
      disableModelInvocation: entry.disableModelInvocation === true,
      lastModifiedAt: typeof entry.lastModifiedAt === 'string' ? entry.lastModifiedAt : null,
    }))
    .filter((entry) => entry.name.length > 0);
}

export function coerceSessionAnalyticsFactors(value: unknown): SessionAnalyticsFactors | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  return {
    promptFamily:
      value.promptFamily === null
        ? null
        : typeof value.promptFamily === 'string'
          ? value.promptFamily
          : null,
    promptHash:
      value.promptHash === null
        ? null
        : typeof value.promptHash === 'string'
          ? value.promptHash
          : null,
    promptCapturedAt:
      value.promptCapturedAt === null
        ? null
        : typeof value.promptCapturedAt === 'string'
          ? value.promptCapturedAt
          : null,
    harnessPromptHash:
      value.harnessPromptHash === null
        ? null
        : typeof value.harnessPromptHash === 'string'
          ? value.harnessPromptHash
          : null,
    customPromptHash:
      value.customPromptHash === null
        ? null
        : typeof value.customPromptHash === 'string'
          ? value.customPromptHash
          : null,
    appendSystemPromptHash:
      value.appendSystemPromptHash === null
        ? null
        : typeof value.appendSystemPromptHash === 'string'
          ? value.appendSystemPromptHash
          : null,
    promptGuidelineHashes: coerceStringArray(value.promptGuidelineHashes),
    contextFiles: coerceContextFiles(value.contextFiles),
    selectedToolIds: coerceStringArray(value.selectedToolIds),
    toolSnippetHashes: coerceToolSnippetHashes(value.toolSnippetHashes),
    toolSetHash:
      value.toolSetHash === null
        ? null
        : typeof value.toolSetHash === 'string'
          ? value.toolSetHash
          : null,
    skills: coerceSkills(value.skills),
    skillSetHash:
      value.skillSetHash === null
        ? null
        : typeof value.skillSetHash === 'string'
          ? value.skillSetHash
          : null,
    activeExtensions: coerceStringArray(value.activeExtensions),
  };
}
