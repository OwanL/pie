// Keep schema constructors on the SDK's legacy-compatible pi-ai entrypoint.
// The runtime aliases this name to the bundled SDK copy; importing TypeBox
// separately would create a second registry instance.
import { StringEnum, Type, type Static } from '@mariozechner/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import type {
  CoordinatorToWorkerResponseFrame,
  WorkerJsonObject,
  WorkerToCoordinatorRequestBody,
} from '../../agent-processes/lib/rpc/worker-protocol.js';

const MESSAGE_MAX_LENGTH = 64 * 1024;
/** Create-time base-title bound (1–25 characters after trimming); target
 *  titles can exceed the base bound through historical suffixes, so the schema
 *  only guards transport size. Bounds are enforced exactly by the coordinator. */
const TARGET_TITLE_MAX_LENGTH = 512;

const SessionControlAction = StringEnum(['list', 'create', 'read', 'message', 'settings.get', 'settings.set', 'close'] as const, {
  description: 'Session operation to perform. list discovers live sessions; create creates/configures a cold session and optionally sends; read pages a transcript; message sends to a live session; settings.get inspects and settings.set persistently updates settings; close uses host lifecycle close.',
});

const SessionControlSettings = Type.Object(
  {
    model: Type.Optional(Type.Object({
      provider: Type.String({ minLength: 1, maxLength: 256 }),
      id: Type.String({ minLength: 1, maxLength: 512 }),
    }, { additionalProperties: false })),
    reasoning: Type.Optional(StringEnum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)),
    autonomousMode: Type.Optional(Type.Boolean()),
    subagentProviderChoices: Type.Optional(Type.Record(
      Type.String({ minLength: 1, maxLength: 256 }),
      Type.Boolean(),
    )),
    disabledSystemPromptEntries: Type.Optional(Type.Array(
      Type.String({ minLength: 1, maxLength: 512 }),
      { maxItems: 256 },
    )),
  },
  { additionalProperties: false },
);

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
    /** create: the required 1-25-character title of the new session. read,
     *  settings, and close: the assigned title of the target session. Provisional
     *  names never resolve; only an assigned title addresses an existing
     *  session. message may use a replyTo reference instead. */
    title: Type.Optional(Type.String({ maxLength: TARGET_TITLE_MAX_LENGTH, description: 'create: required new title, 1–25 characters after trimming. Other actions: exact assigned title from list, not the provisional name.' })),
    /** Target the caller's own session (valid even while it has no assigned
     *  title). Exactly one of title or self is required on read, settings, and
     *  close; message may instead use an identity-bound replyTo reference. */
    self: Type.Optional(Type.Boolean({ description: 'Use true to target this calling session instead of title. Not valid for list or create.' })),
    cwd: Type.Optional(Type.String({ maxLength: 16 * 1024, description: 'create only: working directory; omission inherits the caller’s directory.' })),
    direction: Type.Optional(StringEnum(['older', 'newer', 'latest'] as const)),
    cursor: Type.Optional(TranscriptCursor),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    prompt: Type.Optional(Type.String({ maxLength: MESSAGE_MAX_LENGTH, description: 'message: required content. create: optional initial task sent after configuration succeeds.' })),
    /** For message, address the live original sender by the exact reference
     *  provided in its sender attribution. Cannot be combined with title/self. */
    replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 768 })),
    settings: Type.Optional(Type.Object(SessionControlSettings.properties, {
      additionalProperties: false,
      description: 'Persistent session overrides for create, message, or settings.set. Not temporary per-message settings.',
    })),
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

function requestFailure(error: unknown, action: SessionControlArguments['action']) {
  const message = error instanceof Error ? error.message : String(error);
  if (action === 'create' || action === 'message' || action === 'settings.set' || action === 'close') {
    const result = failure(`${message}. Outcome unknown: the coordinator operation may still continue. Do not automatically retry this request.`);
    return { ...result, details: { ...result.details, outcome: 'unknown' as const } };
  }
  return failure(message);
}

export function createSessionControlTool(request: SessionControlToolRequest): ToolDefinition {
  return {
    name: 'session_control',
    label: 'Session control',
    description: 'Discover and control local primary Pie sessions. Read bounded transcript pages, send attributed messages, inspect or persistently update settings, create configured cold sessions, and close through Pie\'s existing lifecycle.',
    promptSnippet: 'List, read, message, create, inspect/update settings, or close a local Pie session.',
    promptGuidelines: [
      'list exposes live sessions with their assigned titles (field `title`) and provisional `name` labels; only assigned titles address existing sessions.',
      "read, settings, and close require an explicit target: set `self` for the caller's own session or `title` for another live session; message may instead use replyTo.",
      "create requires a 1-25-character title (trimmed), inherits the creator's saved model/reasoning, system-prompt toggles, and execution settings, and configures them before any optional prompt is sent. Without a prompt the new session remains cold. creation.status=not_created confirms no session exists; unknown never authorizes automatic recreation.",
      'Cancellation or a lost mutation acknowledgement does not prove the coordinator stopped; its outcome is unknown and it may continue. Do not automatically repeat create, message, settings, or close requests after such an error.',
      'Use read direction latest for the first page, then pass the returned cursor with direction older or newer. Tool bodies are bounded previews; renderer diagnostics and image bytes are omitted.',
      "message uses ordinary send semantics: an idle target wakes and a busy target receives Pie's normal queued-send behavior. replyTo resolves only while the original sender is live.",
      "settings.get captures the target's saved model, reasoning, system-prompt toggles, and execution preferences; settings.set persists only the supplied patch through its owning settings paths.",
      "close stops active and queued work, removes the tab, and runs host-owned lifecycle cleanup; it does not merely hide a running tab.",
      "A self-close returns after the host accepts responsibility (close requested), which is not a completed-close result; closing another session waits for the hosted stop/cleanup confirmation, or reports explicitly unknown when the acknowledgement is missing.",
      'pass delete:true only when the existing privacy/deletion lifecycle is intended; deletion is committed by the host and can never be undone.',
    ],
    parameters: SessionControlParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate) {
      const typedParams = params as SessionControlArguments;
      const action = typedParams.action;
      const allowed: Record<SessionControlArguments['action'], readonly string[]> = {
        list: ['action'],
        create: ['action', 'title', 'cwd', 'prompt', 'settings'],
        read: ['action', 'title', 'self', 'direction', 'cursor', 'limit'],
        message: ['action', 'title', 'self', 'replyTo', 'prompt', 'settings'],
        'settings.get': ['action', 'title', 'self'],
        'settings.set': ['action', 'title', 'self', 'settings'],
        close: ['action', 'title', 'self', 'delete'],
      };
      if (!Object.hasOwn(allowed, action)) return failure('Unknown session operation.');
      const invalidField = Object.keys(typedParams).find((key) => !allowed[action].includes(key));
      if (invalidField) return failure(`${action} does not accept ${invalidField}.`);

      if (action === 'create') {
        if (typeof typedParams.title !== 'string' || !typedParams.title.trim()) {
          return failure('create requires a title of 1-25 characters.');
        }
        if (typedParams.title.length > TARGET_TITLE_MAX_LENGTH) {
          return failure('create.title is unbounded.');
        }
        const createTitle = typedParams.title.trim();
        if (createTitle.length > 25 || /[\r\n]/.test(createTitle)) {
          return failure('create.title must be a single line of 1-25 characters after trimming. No session was created.');
        }
        if (typedParams.cwd !== undefined && !typedParams.cwd.trim()) {
          return failure('create.cwd must be non-empty when supplied.');
        }
        if (typedParams.prompt !== undefined && !typedParams.prompt.trim()) {
          return failure('create.prompt must be non-empty when supplied.');
        }
        const payload: WorkerJsonObject = {
          title: typedParams.title.trim(),
          ...(typeof typedParams.cwd === 'string' && typedParams.cwd.trim() ? { cwd: typedParams.cwd.trim() } : {}),
          ...(typedParams.prompt !== undefined ? { prompt: typedParams.prompt } : {}),
          ...(typedParams.settings !== undefined
            ? { settings: typedParams.settings as unknown as WorkerJsonObject }
            : {}),
        };
        try {
          const response = await request({ kind: 'session.control', action, payload }, signal);
          if (!response.ok) return failure(`${response.error.code}: ${response.error.message}`);
          return ok(response.result);
        } catch (error) {
          return requestFailure(error, action);
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

      const title = typeof typedParams.title === 'string' && typedParams.title.trim()
        ? typedParams.title.trim()
        : undefined;
      const hasReplyReference = action === 'message' && typeof typedParams.replyTo === 'string';
      if (hasReplyReference && (title || typedParams.self === true)) {
        return failure('message.replyTo cannot be combined with title or self.');
      }
      if (title && typedParams.self === true) {
        return failure('Targeting accepts exactly one of title or self.');
      }
      if (!hasReplyReference && !title && typedParams.self !== true) {
        return failure(`${action} requires an explicit target: an assigned title or the self selector. Provisional names are not addresses.`);
      }
      const target: WorkerJsonObject = hasReplyReference
        ? { replyTo: typedParams.replyTo! }
        : title ? { title } : { self: true };

      let payload: WorkerJsonObject;
      if (action === 'read') {
        const direction = typedParams.direction ?? 'latest';
        if (direction !== 'latest' && !typedParams.cursor) {
          return failure(`${direction} read requires the cursor returned by the previous page.`);
        }
        payload = {
          ...target,
          direction,
          ...(typedParams.cursor ? { cursor: typedParams.cursor as unknown as WorkerJsonObject } : {}),
          ...(typedParams.limit !== undefined ? { limit: typedParams.limit } : {}),
        };
      } else if (action === 'settings.get') {
        payload = target;
      } else if (action === 'settings.set') {
        if (!typedParams.settings || Object.keys(typedParams.settings).length === 0) {
          return failure('settings.set requires at least one setting to update.');
        }
        payload = { ...target, settings: typedParams.settings as unknown as WorkerJsonObject };
      } else if (action === 'message') {
        if (typeof typedParams.prompt !== 'string' || !typedParams.prompt.trim()) {
          return failure('message requires non-empty prompt.');
        }
        if (typedParams.settings && Object.keys(typedParams.settings).length === 0) {
          return failure('message.settings must contain at least one setting when supplied.');
        }
        payload = {
          ...target,
          prompt: typedParams.prompt,
          ...(typedParams.settings ? { settings: typedParams.settings as unknown as WorkerJsonObject } : {}),
        };
      } else {
        payload = { ...target, delete: typedParams.delete === true };
      }

      try {
        const response = await request({ kind: 'session.control', action, payload }, signal);
        if (!response.ok) return failure(`${response.error.code}: ${response.error.message}`);
        return ok(response.result);
      } catch (error) {
        return requestFailure(error, action);
      }
    },
  };
}