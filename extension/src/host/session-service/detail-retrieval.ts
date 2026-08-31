import type { ArchState } from '../core/arch-state.js';
import type { DetailResult, LazyDetailRef } from '../../shared/protocol.js';

export function resolveLiveDetail(
  arch: ArchState,
  sessionPath: string,
  ref: LazyDetailRef,
): DetailResult {
  const turn = arch.livePipeline.turnsBySession[sessionPath];
  if (!turn || turn.canonicalMessageId !== ref.messageId) {
    return { sessionPath, key: ref.key, status: 'stale', message: 'The live detail changed before it was loaded.' };
  }
  if (ref.kind === 'reasoning') {
    const part = turn.parts[ref.partIndex ?? -1];
    if (part?.kind !== 'reasoning' || turn.reasoningBytes !== ref.sourceRevision) {
      return { sessionPath, key: ref.key, status: 'stale', message: 'The live reasoning changed before it was loaded.' };
    }
    return { sessionPath, key: ref.key, status: 'loaded', value: part.text, sizeBytes: ref.sizeBytes };
  }
  const tool = ref.executionId ? arch.livePipeline.toolsByExecutionId[ref.executionId] : undefined;
  const sourceRevision = tool?.progressRevision ?? tool?.seq;
  const value = tool?.terminal?.result ?? tool?.preview;
  const isMovingSubagentDetail = tool?.name.trim().toLowerCase() === 'subagent'
    && typeof ref.sourceRevision === 'number'
    && typeof sourceRevision === 'number'
    && sourceRevision >= ref.sourceRevision;
  if (!tool || (sourceRevision !== ref.sourceRevision && !isMovingSubagentDetail) || value === undefined) {
    return { sessionPath, key: ref.key, status: 'stale', message: 'The live tool result changed before it was loaded.' };
  }
  return {
    sessionPath,
    key: ref.key,
    status: 'loaded',
    value,
    sizeBytes: tool.terminal?.resultBytes ?? tool.previewBytes,
  };
}
