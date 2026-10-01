import type {
  FileBlobComposerInput,
  FilesystemPathComposerInput,
  ImageBlobComposerInput,
} from '../../../harness/agent-processes/lib/rpc/composer-input.js';

export {
  AGENT_MESSAGE_CUSTOM_TYPE,
  AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  AGENT_SESSION_MESSAGE_LOCAL_ID_PREFIX,
  COMPACTION_METRICS_CUSTOM_TYPE,
  isAgentSessionMessageLocalId,
} from '../../../harness/agent-processes/lib/rpc/message-contract.js';
export type {
  ChatMessage,
  ChatMessagePart,
  ChatMessageReasoningPart,
  ChatMessageTextPart,
  ChatMessageToolCallPart,
  CompactionSummaryDetails,
  DetailRequest,
  DetailResult,
  DraftingToolCall,
  LazyDetailKind,
  LazyDetailRef,
  ToolCall,
  ToolCallPhase,
  ToolCallStatus,
  UserContentImagePart,
  UserContentPart,
  UserContentTextPart,
} from '../../../harness/agent-processes/lib/rpc/message-contract.js';
export type { SessionControlSender, SessionControlSenderIdentity } from '../../../harness/agent-processes/lib/rpc/session-control-attribution.js';
export type {
  ComposerInput,
  FileBlobComposerInput,
  FilesystemPathComposerInput,
  ImageBlobComposerInput,
} from '../../../harness/agent-processes/lib/rpc/composer-input.js';

/** Id-less browser draft; the RPC contract adds a host-issued identity. */
export type ComposerInputDraft =
  | Omit<FilesystemPathComposerInput, 'id'>
  | Omit<ImageBlobComposerInput, 'id'>
  | Omit<FileBlobComposerInput, 'id'>;
