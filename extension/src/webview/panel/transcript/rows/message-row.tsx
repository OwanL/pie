/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { MessageItem } from '../message-item';
import { registerRowRenderer, type RowRendererProps } from '../registry';
import { messageRenderIdentity } from '../render-identity';

function renderMessage({
  row,
  busy,
  prefs,
  workingDirectory,
  editingId,
  editingDraft,
  isLastRow,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  renderToolCall,
  sessionKey,
  onCancelPrepass,
  transcript,
  transcriptIndex,
}: RowRendererProps) {
  if (row.kind !== 'message') return null;

  const isStreaming = busy && row.message.role === 'assistant' && row.message.status === 'streaming';
  const isLastAssistantMessage = busy && row.message.role === 'assistant' && isLastRow;
  // Transcript commit evidence signs the live/queued owners and the final
  // three messages. Older completed tools are immutable structure and can be
  // materialized only when they approach the viewport.
  const deferHistoricalToolCalls = row.message.status === 'completed'
    && transcriptIndex !== undefined
    && transcript !== undefined
    && transcriptIndex < Math.max(0, transcript.length - 3);

  return (
    <MessageItem
      key={messageRenderIdentity(row.message)}
      message={row.message}
      isStreaming={isStreaming}
      prefs={prefs}
      readonly={busy && row.message.status !== 'queued'}
      workingDirectory={workingDirectory}
      editingId={editingId}
      editingDraft={editingDraft}
      onEditRequest={onEditRequest}
      onEditConfirm={onEditConfirm}
      onEditCancel={onEditCancel}
      onOpenFile={onOpenFile}
      onContextMenu={onContextMenu}
      renderToolCall={renderToolCall}
      isLastAssistantMessage={isLastAssistantMessage}
      deferHistoricalToolCalls={deferHistoricalToolCalls}
      requestCreatedAt={row.requestCreatedAt}
      pruningHeaderState={row.pruningHeaderState}
      activityState={row.activityState}
      sessionKey={sessionKey}
      onCancelPrepass={onCancelPrepass}
    />
  );
}

registerRowRenderer('message', renderMessage);
