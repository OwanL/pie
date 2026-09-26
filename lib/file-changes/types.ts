/** JSON-safe file-change facts shared by application state and harness tools. */
export type FileChangeKind = 'created' | 'modified' | 'deleted';

export interface FileChangeEntry {
  path: string;
  kind: FileChangeKind;
  toolCallId: string;
  messageId: string;
  description: string;
  timestamp: string;
  additions?: number;
  deletions?: number;
}
