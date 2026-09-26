import type {
  FileBlobComposerInput,
  FilesystemPathComposerInput,
  ImageBlobComposerInput,
} from '../../../harness/agent-processes/lib/rpc/composer-input.js';
import type { PruningDetails } from './settings.js';
import type { CompactionSummaryDetails } from '../../../harness/agent-processes/lib/rpc/message-contract.js';

export { COMPACTION_METRICS_CUSTOM_TYPE } from '../../../harness/agent-processes/lib/rpc/message-contract.js';
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

/** Application detail projection for custom message types. */
export type CustomMessageDetails = PruningDetails | CompactionSummaryDetails | unknown;
