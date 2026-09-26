/** Backend-to-host extension UI request payloads. */
export interface ExtensionUIRequestBase {
  id: string;
  sessionPath: string;
  extensionId?: string;
  subagentCallId?: string;
  toolCallId?: string;
  timeout?: number;
}

export type ExtensionUIRequestPayload =
  | (ExtensionUIRequestBase & { method: 'confirm'; title: string; message: string })
  | (ExtensionUIRequestBase & { method: 'select'; title: string; options: string[]; allowCustom?: boolean })
  | (ExtensionUIRequestBase & { method: 'input'; title: string; placeholder?: string })
  | (ExtensionUIRequestBase & { method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' });

/** Host-to-backend response payload. */
export interface ExtensionUIResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}
