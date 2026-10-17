// Keep schema constructors on the SDK's legacy-compatible pi-ai entrypoint.
// The runtime aliases this name to the bundled SDK copy; importing TypeBox
// separately would create a second registry instance.
import { randomUUID } from 'node:crypto';
import { SESSION_CONTROL_READ_DEFAULT_CHARACTERS, SESSION_CONTROL_READ_MAX_CHARACTERS } from '../../agent-processes/coordinator/session-control-read-bounds.js';
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

const SessionControlAction = StringEnum(['list', 'create', 'read', 'message', 'settings.get', 'settings.set', 'close', 'cleanup', 'operation.status'] as const, {
  description: 'Session operation to perform. list discovers live sessions; create creates/configures a cold session and optionally sends; read pages a transcript; message sends to a live session; settings.get inspects and settings.set persistently updates settings; close uses host lifecycle close; cleanup closes owned sessions; operation.status looks up a mutation by requestKey without replaying it.',
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

const TranscriptCursor = Type.String({ minLength: 1, maxLength: 16 * 1024, description: 'Opaque cursor returned by read. Pass unchanged with older/newer; projection flags must match. A larger maxCharacters does not invalidate it.' });

export const SessionControlParameters = Type.Object(
  {
    action: SessionControlAction,
    /** create: the required 1-25-character title of the new session. read,
     *  settings, and close: the assigned title of the target session. Provisional
     *  names never resolve; only an assigned title addresses an existing
     *  session. message may use a replyTo reference instead. */
    title: Type.Optional(Type.String({ maxLength: TARGET_TITLE_MAX_LENGTH, description: 'create: required new title, 1–25 characters after trimming. Other actions: exact assigned title from list, not the provisional name.' })),
    self: Type.Optional(Type.Boolean({ description: 'Use true to target the authenticated calling primary session instead of title, including when unnamed. For subagent read, this is its owning primary session. Not valid for list, create, cleanup, or operation.status; mutually exclusive with title and replyTo.' })),
    bucket: Type.Optional(StringEnum(['small', 'medium', 'frontier'] as const, { description: 'create only, required: small for simple tasks, medium for well-defined substantial tasks, frontier for hard reasoning.' })),
    cwd: Type.Optional(Type.String({ maxLength: 16 * 1024, description: 'create only: working directory; omission inherits the caller’s directory.' })),
    direction: Type.Optional(StringEnum(['older', 'newer', 'latest'] as const, { description: 'read only: latest (default) starts a fresh read without cursor; older/newer continue with cursor.' })),
    cursor: Type.Optional(TranscriptCursor),
    maxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: SESSION_CONTROL_READ_MAX_CHARACTERS, default: SESSION_CONTROL_READ_DEFAULT_CHARACTERS, description: 'read only: serialized result character budget, default 4000, hard maximum 256*1024. Replaces entry-count limits.' })),
    includeToolCalls: Type.Optional(Type.Boolean({ default: false, description: 'read only: include tool arguments/results; false omits them.' })),
    includeReasoning: Type.Optional(Type.Boolean({ default: false, description: 'read only: include reasoning; false omits it.' })),
    requestKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: 'operation.status only: key returned by a mutation or lost-acknowledgement error. Lookup does not replay the mutation.' })),
    dontCloseRunning: Type.Optional(Type.Boolean({ default: true, description: 'cleanup only: skip running owned sessions by default. Includes all owned sessions, including human-steered ones. Honors existing privacy: normal sessions retain history/results; private sessions use existing deletion.' })),
    prompt: Type.Optional(Type.String({ maxLength: MESSAGE_MAX_LENGTH, description: 'message: required content. create: optional initial task sent after configuration succeeds. Maximum 64 KiB UTF-8, validated before sending.' })),
    /** For message, address the live original sender by the exact reference
     *  provided in its sender attribution. Cannot be combined with title/self. */
    replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 768, description: 'message only: identity-bound original sender reference, mutually exclusive with title or self. Resolves only while the sender remains live.' })),
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

function isIncomplete(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.unknown === true || result.outcome === 'unknown' || result.evidenceUnavailable === true || result.error !== undefined || result.titleAssigned === false
      || (typeof result.failedCount === 'number' && result.failedCount > 0)
      || (typeof result.unknownCount === 'number' && result.unknownCount > 0)) return true;
  if (['failed', 'rejected', 'not_created', 'not_sent', 'not_started', 'unknown', 'unavailable'].includes(String(result.status))) return true;
  return ['creation', 'configuration', 'message', 'operation', 'result', 'results'].some((key) => {
    const phase = result[key];
    return Array.isArray(phase) ? phase.some(isIncomplete) : isIncomplete(phase);
  });
}

function ok(value: unknown, compact = false) {
  return {
    content: [{ type: 'text' as const, text: compact ? JSON.stringify(value) : resultText(value) }],
    details: value,
    isError: isIncomplete(value),
  };
}

function failure(message: string) {
  return {
    content: [{ type: 'text' as const, text: `session_control error: ${message}` }],
    details: { error: message },
    isError: true as const,
  };
}

function requestFailure(error: unknown, requestKey?: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (requestKey) {
    const lookup = { action: 'operation.status', requestKey };
    const result = failure(`${message}. Outcome unknown: the coordinator operation may still continue. Do not automatically retry this request. Lookup: ${JSON.stringify(lookup)}`);
    return { ...result, details: { ...result.details, outcome: 'unknown' as const, requestKey, lookup } };
  }
  return failure(message);
}

export const SessionControlReadOnlyParameters = Type.Object(
  Object.fromEntries(['action', 'title', 'self', 'direction', 'cursor', 'maxCharacters', 'includeToolCalls', 'includeReasoning']
    .map((key) => [key, key === 'action' ? StringEnum(['list', 'read'] as const) : SessionControlParameters.properties[key as keyof typeof SessionControlParameters.properties]])),
  { additionalProperties: false },
);

export function createSessionControlTool(request: SessionControlToolRequest, options: { readOnly?: boolean } = {}): ToolDefinition {
  const tool = {
    name: 'session_control',
    label: 'Session control',
    description: options.readOnly
      ? 'Discover and read local primary Pie sessions. Bounded completed-message reads include incoming messages and activity; tool arguments/results and reasoning are opt-in. Subagents have list/read access only.'
      : 'Discover and control local primary Pie sessions. Read character-bounded completed messages and activity, send attributed messages, inspect/update settings, create sessions, close or clean up owned sessions, and look up mutation outcomes. Tool arguments/results and reasoning are opt-in; subagents have list/read access only.',
    promptSnippet: options.readOnly ? 'List or read a local Pie session.' : 'List, read, message, create, inspect/update settings, close, cleanup, or look up a local Pie session operation.',
    promptGuidelines: options.readOnly ? [
      'list exposes live sessions with their assigned titles (field `title`) and provisional `name` labels; only assigned titles address existing sessions.',
      'Use read direction latest for the first page, then pass the returned cursor with direction older or newer. Tool arguments/results and reasoning are opt-in; renderer diagnostics and image bytes are omitted.',
    ] : [
      'Create new sessions for substantial tasks that can run in parallel with other work and benefit from independent context and ongoing coordination. Use subagents for smaller, bounded tasks that return a result directly.',
      'Include the task, ownership boundaries, and expected handoff in the initial prompt.',
      'Message decisions, blockers, interface changes, and final findings; omit routine progress and acknowledgements',
      'Receiving a message does not itself require a reply.',
      'list exposes live sessions with their assigned titles (field `title`) and provisional `name` labels; only assigned titles address existing sessions.',
      "read, settings, and close require an explicit target: set `self` for the caller's own primary session or `title` for another live session; message may instead use replyTo. Target selectors are mutually exclusive.",
      "create requires a 1-25-character title (trimmed) and an explicit bucket: small for simple tasks, medium for well-defined substantial tasks, frontier for hard reasoning. Bucket selection uses the caller's provider policy and bucket reasoning unless settings.reasoning overrides it; settings.model is not accepted. System-prompt toggles and execution settings are inherited and configured before any optional prompt is sent. Without a prompt the new session remains cold. creation.status=not_created confirms no session exists; unknown never authorizes automatic recreation.",
      'Cancellation or a lost mutation acknowledgement does not prove the coordinator stopped; its outcome is unknown and it may continue. Do not automatically repeat create, message, settings, or close requests after such an error.',
      'Use read direction latest for the first page, then pass the returned cursor with direction older or newer. Tool arguments/results and reasoning are opt-in; renderer diagnostics and image bytes are omitted.',
      'Prefer cheaper subagents for large-output inspection; use bounded reads for small checks.',
      "message uses ordinary send semantics: an idle target wakes and a busy target receives Pie's normal queued-send behavior. replyTo resolves only while the original sender is live.",
      "settings.get captures the target's saved model, reasoning, system-prompt toggles, and execution preferences; settings.set persists only the supplied patch through its owning settings paths.",
      'Close sessions you created once their results are collected and no further work is needed. Before completing the parent task, check for any you left open. Use ordinary close, not deletion.',
      "close stops active and queued work, removes the tab, and runs host-owned lifecycle cleanup; collect needed results first. It does not merely hide a running tab.",
      'Before cleanup, check for owned sessions the user is still using; close sessions individually if any should remain open',
      'A self-close returns after the host accepts responsibility (close requested), which is not a completed-close result; closing another session waits for the hosted stop/cleanup confirmation, or reports explicitly unknown when the acknowledgement is missing.',
      'pass delete:true only when the existing privacy/deletion lifecycle is intended; deletion is committed by the host and can never be undone.',
    ],
    parameters: options.readOnly ? SessionControlReadOnlyParameters : SessionControlParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate) {
      const typedParams = params as SessionControlArguments;
      const action = typedParams.action;
      const allowed: Record<SessionControlArguments['action'], readonly string[]> = {
        list: ['action'],
        create: ['action', 'title', 'bucket', 'cwd', 'prompt', 'settings'],
        read: ['action', 'title', 'self', 'direction', 'cursor', 'maxCharacters', 'includeToolCalls', 'includeReasoning'],
        message: ['action', 'title', 'self', 'replyTo', 'prompt', 'settings'],
        'settings.get': ['action', 'title', 'self'],
        'settings.set': ['action', 'title', 'self', 'settings'],
        close: ['action', 'title', 'self', 'delete'],
        cleanup: ['action', 'dontCloseRunning'],
        'operation.status': ['action', 'requestKey'],
      };
      if (!Object.hasOwn(allowed, action)) return failure('Unknown session operation.');
      if (options.readOnly && action !== 'list' && action !== 'read') return failure('Subagents may only list and read sessions.');
      const invalidField = Object.keys(typedParams).find((key) => !allowed[action].includes(key));
      if (invalidField) return failure(`${action} does not accept ${invalidField}.`);

      if (typedParams.prompt !== undefined && (typeof typedParams.prompt !== 'string' || Buffer.byteLength(typedParams.prompt, 'utf8') > MESSAGE_MAX_LENGTH)) {
        return failure('prompt must not exceed 64 KiB UTF-8.');
      }
      const mutation = ['create', 'message', 'settings.set', 'close', 'cleanup'].includes(action);
      const requestKey = mutation ? `${Date.now()}:${randomUUID()}` : undefined;
      const send = async (payload: WorkerJsonObject) => {
        try {
          const response = await request({ kind: 'session.control', action, payload: { ...payload, ...(requestKey ? { requestKey } : {}) } }, signal);
          if (!response.ok) {
            const result = failure(`${response.error.code}: ${response.error.message}`);
            return requestKey ? { ...result, details: { ...result.details, requestKey } } : result;
          }
          return ok(requestKey ? { ...(response.result as WorkerJsonObject), requestKey } : response.result, action === 'read');
        } catch (error) {
          return requestFailure(error, requestKey);
        }
      };

      if (action === 'operation.status') {
        if (typeof typedParams.requestKey !== 'string' || !typedParams.requestKey.trim() || typedParams.requestKey.length > 512) return failure('operation.status requires a bounded requestKey.');
        return send({ requestKey: typedParams.requestKey });
      }
      if (action === 'cleanup') {
        if (typedParams.dontCloseRunning !== undefined && typeof typedParams.dontCloseRunning !== 'boolean') return failure('cleanup.dontCloseRunning must be boolean.');
        return send({ dontCloseRunning: typedParams.dontCloseRunning ?? true });
      }
      if (action === 'create') {
        if (!['small', 'medium', 'frontier'].includes(typedParams.bucket ?? '')) {
          return failure('create requires bucket: small, medium, or frontier.');
        }
        if (typedParams.settings && Object.hasOwn(typedParams.settings, 'model')) {
          return failure('create.settings.model is not accepted; use bucket to select the model.');
        }
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
          bucket: typedParams.bucket!,
          ...(typeof typedParams.cwd === 'string' && typedParams.cwd.trim() ? { cwd: typedParams.cwd.trim() } : {}),
          ...(typedParams.prompt !== undefined ? { prompt: typedParams.prompt } : {}),
          ...(typedParams.settings !== undefined
            ? { settings: typedParams.settings as unknown as WorkerJsonObject }
            : {}),
        };
        return send(payload);
      }

      if (action === 'list') return send({});

      const title = typeof typedParams.title === 'string' && typedParams.title.trim()
        ? typedParams.title.trim()
        : undefined;
      const hasReplyReference = action === 'message' && typeof typedParams.replyTo === 'string';
      if (typedParams.self !== undefined && typedParams.self !== true) return failure('self must be true when supplied.');
      if (hasReplyReference && (typedParams.title !== undefined || typedParams.self !== undefined)) return failure('message.replyTo cannot be combined with title or self.');
      if (typedParams.title !== undefined && typedParams.self !== undefined) return failure('Targeting accepts exactly one of title or self.');
      if (hasReplyReference && (!typedParams.replyTo || typedParams.replyTo.length > 768)) return failure('message.replyTo must be a bounded non-empty reference.');
      if (!hasReplyReference && typedParams.self !== true && (!title || title.length > TARGET_TITLE_MAX_LENGTH)) {
        return failure(`${action} requires an explicit target: an assigned title or self. Provisional names are not addresses.`);
      }
      const target: WorkerJsonObject = hasReplyReference ? { replyTo: typedParams.replyTo! } : typedParams.self === true ? { self: true } : { title: title! };

      let payload: WorkerJsonObject;
      if (action === 'read') {
        const direction = typedParams.direction ?? 'latest';
        if (!['latest', 'older', 'newer'].includes(direction)) return failure('Invalid read direction.');
        if (direction === 'latest' && typedParams.cursor !== undefined) return failure('latest starts a fresh read without cursor.');
        if (direction !== 'latest' && (typeof typedParams.cursor !== 'string' || !typedParams.cursor || typedParams.cursor.length > 16 * 1024)) {
          return failure(`${direction} read requires the opaque cursor returned by the previous page.`);
        }
        const maxCharacters = typedParams.maxCharacters ?? SESSION_CONTROL_READ_DEFAULT_CHARACTERS;
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > SESSION_CONTROL_READ_MAX_CHARACTERS) return failure('read.maxCharacters must be an integer from 1 to 256*1024.');
        for (const key of ['includeToolCalls', 'includeReasoning'] as const) {
          if (typedParams[key] !== undefined && typeof typedParams[key] !== 'boolean') return failure(`read.${key} must be boolean.`);
        }
        payload = {
          ...target,
          direction,
          ...(typedParams.cursor ? { cursor: typedParams.cursor } : {}),
          maxCharacters,
          includeToolCalls: typedParams.includeToolCalls ?? false,
          includeReasoning: typedParams.includeReasoning ?? false,
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

      return send(payload);
    },
  } satisfies ToolDefinition;
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      // The SDK marks only thrown executions as errors. Keep this outside send's
      // transport catch so known failures are not relabeled as unknown outcomes.
      if (result.isError) throw new Error(`session_control error: ${JSON.stringify(result.details)}`);
      return result;
    },
  };
}