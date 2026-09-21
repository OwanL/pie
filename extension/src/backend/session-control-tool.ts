// Keep schema constructors on the SDK's legacy-compatible pi-ai entrypoint.
// The runtime aliases this name to the bundled SDK copy; importing TypeBox
// separately would create a second registry instance.
import { StringEnum, Type, type Static } from '@mariozechner/pi-ai';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type {
  CoordinatorToWorkerResponseFrame,
  WorkerJsonObject,
  WorkerToCoordinatorRequestBody,
} from './worker-protocol';

const SESSION_PATH_MAX_LENGTH = 16 * 1024;
const MESSAGE_MAX_LENGTH = 64 * 1024;

const SessionControlAction = StringEnum(['list', 'create', 'read', 'message', 'close'] as const, {
  description: 'Session operation to perform. list discovers local sessions; create makes a cold session; read pages a transcript; message sends a normal message; close uses host lifecycle close.',
});

const TranscriptCursor = Type.Object(
  {
    start: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    end: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const SessionControlParameters = Type.Object(
  {
    action: SessionControlAction,
    sessionPath: Type.Optional(Type.String({ maxLength: SESSION_PATH_MAX_LENGTH })),
    cwd: Type.Optional(Type.String({ maxLength: SESSION_PATH_MAX_LENGTH })),
    direction: Type.Optional(StringEnum(['older', 'newer', 'latest'] as const)),
    cursor: Type.Optional(TranscriptCursor),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    text: Type.Optional(Type.String({ maxLength: MESSAGE_MAX_LENGTH })),
    delete: Type.Optional(Type.Boolean({ description: 'For close, request the existing privacy/deletion lifecycle.' })),
  },
  { additionalProperties: false },
);

type SessionControlArguments = Static<typeof SessionControlParameters>;
type SessionControlResultFrame = Extract<CoordinatorToWorkerResponseFrame, { kind: 'session.control.result' }>;

export type SessionControlToolRequest = (
  body: WorkerToCoordinatorRequestBody,
  signal?: AbortSignal,
) => Promise<SessionControlResultFrame>;

interface SessionToolContext extends ExtensionContext {
  sessionManager: ExtensionContext['sessionManager'] & {
    getSessionFile(): string | undefined;
  };
}

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function ok(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: resultText(value) }],
    details: value,
    isError: false as const,
  };
}

function failure(message: string) {
  return {
    content: [{ type: 'text' as const, text: `session_control error: ${message}` }],
    details: { error: message },
    isError: true as const,
  };
}

function currentSessionPath(ctx: SessionToolContext): string | undefined {
  const value = ctx.sessionManager.getSessionFile();
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function targetSessionPath(
  params: SessionControlArguments,
  ctx: SessionToolContext,
): string | undefined {
  if (typeof params.sessionPath === 'string' && params.sessionPath.trim()) return params.sessionPath.trim();
  return currentSessionPath(ctx);
}

export function createSessionControlTool(request: SessionControlToolRequest): ToolDefinition {
  return {
    name: 'session_control',
    label: 'Session control',
    description: 'Discover and control local primary Pie sessions. Read bounded transcript pages with a cursor, send ordinary messages to idle or busy sessions, create cold sessions, and close through Pie\'s existing lifecycle.',
    promptSnippet: 'List, read, message, create, or close a local Pie session through host-owned lifecycle controls.',
    promptGuidelines: [
      'Only sessions in the current extension host\'s local catalog are addressable; do not guess paths from another window.',
      'Use read direction latest for the first page, then pass the returned cursor with direction older or newer.',
      'message uses ordinary send semantics: an idle target wakes and a busy target receives Pie\'s normal queued-send behavior.',
      'close defaults to a reversible lifecycle close; pass delete:true only when the existing privacy/deletion behavior is intended.',
      'create returns a cold session path; message can subsequently wake it and promote its isolated runtime.',
    ],
    parameters: SessionControlParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const typedParams = params as SessionControlArguments;
      const action = typedParams.action;
      const sessionPath = targetSessionPath(typedParams, ctx as SessionToolContext);

      if (action === 'create') {
        const payload: WorkerJsonObject = {
          ...(typeof typedParams.cwd === 'string' && typedParams.cwd.trim() ? { cwd: typedParams.cwd.trim() } : {}),
        };
        try {
          const response = await request({ kind: 'session.control', action, payload }, signal);
          if (!response.ok) return failure(`${response.error.code}: ${response.error.message}`);
          return ok(response.result);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      }

      if (action === 'list') {
        try {
          const response = await request({ kind: 'session.control', action, payload: {} }, signal);
          if (!response.ok) return failure(`${response.error.code}: ${response.error.message}`);
          return ok(response.result);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      }

      if (!sessionPath) return failure(`${action} requires a current session or an explicit sessionPath.`);

      let payload: WorkerJsonObject;
      if (action === 'read') {
        const direction = typedParams.direction ?? 'latest';
        if (direction !== 'latest' && !typedParams.cursor) {
          return failure(`${direction} read requires the cursor returned by the previous page.`);
        }
        payload = {
          sessionPath,
          direction,
          ...(typedParams.cursor ? { cursor: typedParams.cursor as unknown as WorkerJsonObject } : {}),
          ...(typedParams.limit !== undefined ? { limit: typedParams.limit } : {}),
        };
      } else if (action === 'message') {
        if (typeof typedParams.text !== 'string' || !typedParams.text.trim()) {
          return failure('message requires non-empty text.');
        }
        payload = { sessionPath, text: typedParams.text };
      } else {
        payload = { sessionPath, delete: typedParams.delete === true };
      }

      try {
        const response = await request({ kind: 'session.control', action, payload }, signal);
        if (!response.ok) return failure(`${response.error.code}: ${response.error.message}`);
        return ok(response.result);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
