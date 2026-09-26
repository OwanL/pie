import type { ToolCall } from '../../../harness/agent-processes/lib/rpc/message-contract.js';
import { normalizeToolCallName } from './summary';
import {
  EMPTY_FILE_MUTATION_DELTA,
  type FileExtensionAnalysis,
  type FileMutationDelta,
} from './mutation-types';
import {
  WRITE_CONTENT_KEYS,
  extractExtensionFromPath,
  extractFirstPathFromInput,
  getFileExtensionOperation,
  hasToolCallPathInput,
  hashPath,
  looksLikeCreateTool,
  looksLikeDeleteTool,
  looksLikeEditTool,
  looksLikeReadTool,
  looksLikeRenameTool,
} from './mutation-tools';
import {
  editStatsFromPatchText,
  getEditStatsFromInput,
  getPatchTextFromInput,
  lineCountFromRecordKeys,
} from './mutation-size';

function parsePatchOperations(
  patchText: string,
): Pick<FileMutationDelta, 'writeCount' | 'editCount' | 'deleteCount' | 'renameCount' | 'touchedFileCount' | 'editCountsByFile'> {
  let writeCount = 0;
  let editCount = 0;
  let deleteCount = 0;
  let renameCount = 0;
  const editCountsByFile: Record<string, number> = {};

  for (const line of patchText.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('*** Add File:')) {
      writeCount += 1;
      continue;
    }

    if (line.startsWith('*** Update File:')) {
      editCount += 1;
      // Attribute this edit to its file for the churn signal. Path follows the marker.
      const filePath = line.slice('*** Update File:'.length).trim();
      if (filePath.length > 0) {
        const key = hashPath(filePath);
        editCountsByFile[key] = (editCountsByFile[key] ?? 0) + 1;
      }
      continue;
    }

    if (line.startsWith('*** Delete File:')) {
      deleteCount += 1;
      continue;
    }

    if (line.startsWith('*** Move to:') || line.startsWith('rename to ')) {
      renameCount += 1;
    }
  }

  const explicitFileOps = writeCount + editCount + deleteCount;
  const touchedFileCount = explicitFileOps > 0 ? explicitFileOps : renameCount;
  return { writeCount, editCount, deleteCount, renameCount, touchedFileCount, editCountsByFile };
}

function buildFileMutationDelta(partial: Partial<FileMutationDelta>): FileMutationDelta {
  return {
    writeCount: partial.writeCount ?? 0,
    editCount: partial.editCount ?? 0,
    deleteCount: partial.deleteCount ?? 0,
    renameCount: partial.renameCount ?? 0,
    touchedFileCount: partial.touchedFileCount ?? 0,
    lineAdditions: partial.lineAdditions ?? 0,
    lineDeletions: partial.lineDeletions ?? 0,
    lineModifications: partial.lineModifications ?? 0,
    editCountsByFile: partial.editCountsByFile ?? {},
    readCountsByFile: partial.readCountsByFile ?? {},
  };
}

function fileMutationFromPatch(toolCall: ToolCall): FileMutationDelta | null {
  if (!(toolCall.input && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input))) {
    return null;
  }

  const patchText = getPatchTextFromInput(toolCall.input as Record<string, unknown>);
  if (!patchText) {
    return null;
  }

  const fileOps = parsePatchOperations(patchText);
  const stats = editStatsFromPatchText(patchText) ?? { additions: 0, deletions: 0, modifications: 0 };
  const touchedFileCount = fileOps.touchedFileCount > 0 ? fileOps.touchedFileCount : 1;
  const editCount = fileOps.editCount > 0 || fileOps.touchedFileCount === 0 ? Math.max(fileOps.editCount, 1) : 0;

  return buildFileMutationDelta({
    ...fileOps,
    editCount,
    touchedFileCount,
    lineAdditions: stats.additions,
    lineDeletions: stats.deletions,
    lineModifications: stats.modifications,
  });
}

export function getFileMutationFromToolCall(toolCall: ToolCall): FileMutationDelta {
  const normalizedToolName = normalizeToolCallName(toolCall.name);
  const patchDelta = fileMutationFromPatch(toolCall);
  if (patchDelta) {
    return patchDelta;
  }

  const hasPathInput = hasToolCallPathInput(toolCall);
  if (!hasPathInput || !(toolCall.input && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input))) {
    return createEmptyFileMutationDelta();
  }

  const input = toolCall.input as Record<string, unknown>;

  if (looksLikeRenameTool(normalizedToolName)) {
    return buildFileMutationDelta({ renameCount: 1, touchedFileCount: 1 });
  }

  if (looksLikeDeleteTool(normalizedToolName)) {
    return buildFileMutationDelta({ deleteCount: 1, touchedFileCount: 1 });
  }

  if (looksLikeCreateTool(normalizedToolName)) {
    const lineAdditions = lineCountFromRecordKeys(input, WRITE_CONTENT_KEYS) ?? 0;
    return buildFileMutationDelta({
      writeCount: 1,
      touchedFileCount: 1,
      lineAdditions,
    });
  }

  if (looksLikeEditTool(normalizedToolName)) {
    const combinedStats = getEditStatsFromInput(input);
    const editCountsByFile: Record<string, number> = {};
    const filePath = extractFirstPathFromInput(input);
    if (filePath) {
      editCountsByFile[hashPath(filePath)] = 1;
    }
    return buildFileMutationDelta({
      editCount: 1,
      touchedFileCount: 1,
      lineAdditions: combinedStats?.additions ?? 0,
      lineDeletions: combinedStats?.deletions ?? 0,
      lineModifications: combinedStats?.modifications ?? 0,
      editCountsByFile,
    });
  }

  if (looksLikeReadTool(normalizedToolName)) {
    // Reads are not mutations — they don't touch (modify) a file — so only the
    // per-file read attribution is recorded, mirroring `editCountsByFile` for
    // the "files reviewed" breadth + re-read churn signals. Reads whose path
    // can't be extracted still count via `readCountsByExtension`.
    const readCountsByFile: Record<string, number> = {};
    const filePath = extractFirstPathFromInput(input);
    if (filePath) {
      readCountsByFile[hashPath(filePath)] = 1;
    }
    return buildFileMutationDelta({ readCountsByFile });
  }

  return createEmptyFileMutationDelta();
}

export function mergeFileMutationDelta(
  current: FileMutationDelta,
  next: FileMutationDelta,
): FileMutationDelta {
  return {
    writeCount: current.writeCount + next.writeCount,
    editCount: current.editCount + next.editCount,
    deleteCount: current.deleteCount + next.deleteCount,
    renameCount: current.renameCount + next.renameCount,
    touchedFileCount: current.touchedFileCount + next.touchedFileCount,
    lineAdditions: current.lineAdditions + next.lineAdditions,
    lineDeletions: current.lineDeletions + next.lineDeletions,
    lineModifications: current.lineModifications + next.lineModifications,
    editCountsByFile: mergeCountsByFile(current.editCountsByFile, next.editCountsByFile),
    readCountsByFile: mergeCountsByFile(current.readCountsByFile, next.readCountsByFile),
  };
}

function mergeCountsByFile(
  current: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...(current ?? {}) };
  for (const [key, count] of Object.entries(next ?? {})) {
    merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}

export function createEmptyFileMutationDelta(): FileMutationDelta {
  return { ...EMPTY_FILE_MUTATION_DELTA, editCountsByFile: {}, readCountsByFile: {} };
}

export function getFileExtensionFromToolCall(toolCall: ToolCall): FileExtensionAnalysis | null {
  const filePath = extractFirstPathFromInput(toolCall.input);
  if (!filePath) {
    return null;
  }

  const operation = getFileExtensionOperation(toolCall.name);
  if (!operation) {
    return null;
  }

  return {
    extension: extractExtensionFromPath(filePath),
    operation,
  };
}
