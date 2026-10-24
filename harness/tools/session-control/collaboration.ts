import { randomUUID } from 'node:crypto';
import { StringEnum, Type } from '@mariozechner/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkerJsonObject, WorkerSessionControlAction } from '../../agent-processes/lib/rpc/worker-protocol.js';
import { createSessionControlTool, SessionControlParameters, type SessionControlToolRequest } from './index.js';

const target = Type.String({ minLength: 1, maxLength: 768, description: 'Copy the compact pie-session:v1 address from session_control list/create, or use an exact assigned title. Addresses survive renames; never reconstruct one from memory. Historical pie-reply references also work. Notes and assignments target another session.' });
const taskId = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 1, description: 'Accepted task revision. Copy from the assignment or task inspection.' });
const text = (description: string, maxLength = 16 * 1024) => Type.String({ minLength: 1, maxLength, description });

function incomplete(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(incomplete);
  const row = value as Record<string, unknown>;
  return row.unknown === true || row.outcome === 'unknown' || row.error !== undefined
    || ['rejected', 'unknown', 'not_created', 'not_sent', 'unavailable', 'failed'].includes(String(row.status))
    || ['creation', 'configuration', 'message', 'operation'].some(key => incomplete(row[key]));
}

/** Small operation-specific schemas share the authenticated worker transport.
 * A note cannot acquire the assignment tool's wake capability through arguments. */
export function createSessionCollaborationTools(request: SessionControlToolRequest): ToolDefinition[] {
  const call = async (action: WorkerSessionControlAction, payload: WorkerJsonObject, signal?: AbortSignal, mutation = false) => {
    const requestKey = mutation ? `${Date.now()}:${randomUUID()}` : undefined;
    let result: unknown;
    try {
      const response = await request({ kind: 'session.control', action, payload: { ...payload, ...(requestKey ? { requestKey } : {}) } }, signal);
      if (!response.ok) throw Object.assign(new Error(response.error.message), { knownRejection: true });
      result = response.result;
    } catch (error) {
      const known = error instanceof Error && 'knownRejection' in error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(JSON.stringify({ error: message, ...(requestKey ? {
        requestKey, ...(known ? {} : { outcome: 'unknown', lookup: { action: 'operation.status', requestKey }, guidance: 'Inspect the original operation; do not repeat the assignment or create a replacement automatically.' }),
      } : {}) }));
    }
    if (incomplete(result)) throw new Error(JSON.stringify(result));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
  };
  const waitCall = async (action: 'wait' | 'resources', args: WorkerJsonObject, signal?: AbortSignal) => {
    const waitId = randomUUID();
    const cancel = () => { void request({ kind: 'session.control', action: 'wait.cancel', payload: { waitId } }).catch(() => undefined); };
    if (signal?.aborted) {
      cancel();
      throw new Error('Session wait aborted before registration.');
    }
    signal?.addEventListener('abort', cancel, { once: true });
    try { return await call(action, { ...args, waitId, timeoutMs: args.timeoutMs ?? 60_000 }, signal); }
    finally { signal?.removeEventListener('abort', cancel); }
  };
  const legacy = createSessionControlTool(request);
  const properties = Object.fromEntries(Object.entries(SessionControlParameters.properties)
    .filter(([key]) => !['replyTo', 'expectReply', 'fulfills'].includes(key)));
  properties.action = StringEnum(['list', 'create', 'read', 'settings.get', 'settings.set', 'interrupt', 'close', 'cleanup', 'operation.status'] as const);
  properties.address = Type.Optional(target);
  properties.self = Type.Optional(Type.Boolean({ description: 'Use true to target the authenticated calling primary session, including when unnamed. For subagent read, this is its owning primary session. Not valid for list, create, cleanup, or operation.status; mutually exclusive with title and address.' }));
  properties.settings = Type.Optional(Type.Object(SessionControlParameters.properties.settings.properties, {
    additionalProperties: false,
    description: 'Persistent overrides for create or settings.set. create rejects settings.model: select a bucket and inherit provider/model policy. An explicit model override is valid only for settings.set.',
  }));
  properties.prompt = Type.Optional(Type.String({
    maxLength: 16 * 1024,
    description: 'create only: optional initial task assignment, maximum 16 KiB UTF-8. Use file references for larger context.',
  }));
  const control: ToolDefinition = {
    ...legacy,
    description: 'Discover, create, inspect, configure, interrupt, and close local Pie sessions. Creation preserves your settings and provider/model-bucket policy. Use session_send for information and session_assign for work.',
    promptSnippet: 'Discover and manage independent Pie sessions; create with bucket and optional initial assignment.',
    promptGuidelines: [
      'Use bounded subagents for a focused direct result. Create independent sessions for sustained parallel work or human steering. Give each assignment ownership, expected output, and a stopping condition.',
      'list includes live sessions in this host, including unrelated peers, identity-bound addresses and task state. Use session_resources status for measured worker memory. Use address for read, settings, interrupt, or close; exact assigned titles and self remain supported.',
      'create requires title (1–25 characters) and bucket small, medium, or frontier. It inherits execution settings, system-prompt choices, provider choices and model buckets before starting an optional prompt. Do not pass settings.model on creation; the bucket selects within inherited provider/model policy. A prompt creates an explicit assignment; collect its taskId and revision. Without prompt the session remains cold.',
      'A new independent session has its own history; it does not inherit your conversation or files you have already read. Pass the relevant contract or file references and exact output requirements in its assignment.',
      'Information and task results never start idle sessions. session_assign starts work; session_send gives context; session_finish commits one result for the actual requester; session_wait receives results without transcript polling.',
      'interrupt stops active and queued work while retaining the session. You may interrupt yourself, sessions you created, or a worker executing your current assignment. close/delete and settings changes require self or direct creator ownership. close stops and closes through the host lifecycle; collect results and check human use before cleanup. Self-close reports acceptance, not completed teardown.',
      'Close delegated sessions you created once their results have been collected and no further work is needed. Make this part of task completion rather than leaving cleanup to the user. Keep a session open only for planned follow-up work or ongoing user interaction. Do not close unrelated sessions or sessions the user is actively using.',
      'read returns bounded transcript pages for diagnosis. Tool calls and reasoning are opt-in. Activity, idle state, and a closed tab do not prove an assignment succeeded.',
      'Settings changes are persistent overrides for your own or directly created sessions. Keep them separate from notes. Bucket/provider intent remains authoritative for creation; create.settings.model is not accepted.',
      'Creation/configuration/assignment may partially succeed. If an acknowledgement is lost, inspect operation.status using the returned requestKey. Never automatically recreate or repeat an uncertain operation.',
      'Task/mailbox/resource records last for this coordinator lifetime. After restart unavailable does not mean work never happened. No replay is performed.',
    ],
    parameters: Type.Object(properties, { additionalProperties: false }),
    async execute(id, raw, signal, onUpdate) {
      const args = raw as WorkerJsonObject;
      if (!['list', 'create', 'read', 'settings.get', 'settings.set', 'interrupt', 'close', 'cleanup', 'operation.status'].includes(String(args.action))) throw new Error('Unknown session lifecycle operation. Use session_send for information or session_assign for work.');
      if (args.action === 'interrupt' || args.address !== undefined) {
        const { action, ...payload } = args;
        if (typeof action !== 'string' || !['read', 'settings.get', 'settings.set', 'interrupt', 'close'].includes(action)) throw new Error('address is supported only for an explicit existing-session operation.');
        return call(action as WorkerSessionControlAction, payload, signal, ['settings.set', 'interrupt', 'close'].includes(action));
      }
      return legacy.execute(id, raw, signal, onUpdate);
    },
  };
  return [control, {
    name: 'session_send', label: 'Send session note',
    description: 'Send bounded information to another live session without starting an idle model turn. A running recipient receives it at a safe boundary; a cold recipient retains it until its next run or explicit wait. No acknowledgement or result is requested.',
    promptSnippet: 'Send a decision, blocker, or context without waking an idle peer.',
    promptGuidelines: ['Use session_assign when an answer or new work is required. Do not send routine acknowledgements, status pings, or duplicate final reports. Notes do not cancel or complete assignments.',
      'Batch related information. Per-peer and recipient burst/rate limits reject excess traffic before delivery. Honor retryAfterMs and continue independent work; do not spin on retries. An identical recent note returns the original outcome without another send, including unknown outcomes. A full recipient queue can reject a note even when its session is running.'],
    parameters: Type.Object({ target, message: text('Information only; maximum 16 KiB UTF-8.') }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: (_id, args, signal) => call('note', args as WorkerJsonObject, signal, true),
  }, {
    name: 'session_assign', label: 'Assign session task',
    description: 'Assign bounded work to a live session and request a new turn. The coordinator fixes the requester and worker, returns taskId/revision, and rejects busy workers rather than silently merging tasks. The same result rule applies to creators and unrelated peers.',
    promptSnippet: 'Assign work with an explicit result and stopping condition; inspect it with session_wait.',
    promptGuidelines: [
      'Include scope, file ownership, relevant contract or file references, exact output format, and completion checks in prompt. The worker does not automatically see your conversation. Use identity-bound target addresses from list/create.',
      'Wait only when the result blocks progress; continue independent work otherwise. Accepted means admission only: task.status becomes running on observed turn start. Neither state proves completion.',
      'To resume an awaiting-result assignment, supply its taskId and current revision. This advances the revision; old finishes are rejected. To change active work, interrupt it and issue a new assignment after its stop is confirmed.',
      'If busy, choose another worker or wait. Do not repeatedly send the same assignment or use notes to wake it.',
    ],
    parameters: Type.Object({ target, prompt: text('Bounded assignment, expected result and stopping condition; maximum 16 KiB UTF-8.'), taskId: Type.Optional(taskId), revision: Type.Optional(revision) }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: (_id, args, signal) => call('task.assign', args as WorkerJsonObject, signal, true),
  }, {
    name: 'session_finish', label: 'Finish session task',
    description: 'Commit the assigned task’s result once for its fixed requester. Only its worker may finish the accepted revision. The result is stored before notification; identical repeated finishes return the same result, conflicting or stale finishes reject.',
    promptSnippet: 'Record the assignment outcome before ending its work.',
    promptGuidelines: [
      'Call once with the taskId/revision from the authenticated assignment. Include the deliverable, evidence, tests and remaining blockers. The requester verifies your completion claim.',
      'Use blocked when work cannot proceed without input; blocked is a terminal outcome, so report the blocker and stop. The requester can decide whether to issue a new assignment after resolving it. Use failed for an unsuccessful attempt and cancelled for abandoned work. Do not separately send the same final by session_send.',
      'Finishing does not close your session. If a run settles without finish, the task remains awaiting-result; the runtime does not invent success or send automatic nudges.',
    ],
    parameters: Type.Object({ taskId, revision, outcome: StringEnum(['completed', 'failed', 'blocked', 'cancelled'] as const), result: text('Concise result and verification evidence, maximum 32 KiB UTF-8.', 32 * 1024) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_id, args, signal) {
      try { return await call('task.finish', args as WorkerJsonObject, signal); }
      catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Inspect this task with session_wait ${JSON.stringify({ taskIds: [(args as WorkerJsonObject).taskId], timeoutMs: 0 })}. An identical finish for the same task/revision/result is idempotent; do not create a replacement task to recover a lost acknowledgement.`);
      }
    },
  }, {
    name: 'session_wait', label: 'Wait for session work',
    description: 'Inspect assignment results or wait for relevant task changes and incoming information without polling model turns. Already available results return immediately. A result never wakes an idle requester; arm this wait while blocked or inspect later with timeoutMs:0.',
    promptSnippet: 'Wait on the critical path; timeoutMs:0 inspects task evidence.',
    promptGuidelines: ['Pass taskIds to inspect/wait for specific assignments; omit to receive your mailbox. A timeout or awaiting-result state is not success. User Stop cancels the wait. Avoid status-ping and transcript-polling loops.'],
    parameters: Type.Object({ taskIds: Type.Optional(Type.Array(taskId, { minItems: 1, maxItems: 16, uniqueItems: true })), timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300_000, default: 60_000 })), afterRevision: Type.Optional(Type.Integer({ minimum: 0, description: 'Record-version cursor returned as revision by a prior wait; this is distinct from the accepted assignment revision used by session_finish.' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: (_id, raw, signal) => waitCall('wait', raw as WorkerJsonObject, signal),
  }, {
    name: 'session_resources', label: 'Coordinate session resources',
    description: 'Inspect measured host/worker memory and cooperative named resource reservations. Reserve scarce hardware or shared-checkout checks, acknowledge start before the deadline, and release explicitly. These agreements do not enforce OS memory limits or replace existing build/provider gates.',
    promptSnippet: 'Inspect hardware pressure and coordinate scarce resources with peers.',
    promptGuidelines: ['Use the same exact resource name with peers, such as checkout:pie or gpu:0. Acquire and wait default to exclusive mode; set shared explicitly for compatible simultaneous work. Acquire reserves; call start successfully before beginning the resource-consuming work. Choose ttlMs for the expected work and cleanup, and renew before expiry if more time is needed. Release after that work and owned processes stop. An expired active lease still blocks contenders because expiry does not prove shutdown. Contact its owner before recovery.',
      'Status reports host-wide free memory and each worker process\'s sampled RSS, not total session memory: bash, compilers, and other child processes are excluded. Small worker RSS does not prove its work is cheap or stopped. Use the returned address to contact the owner of known heavy work; coordinate an exact named lease before starting another heavy job.',
      'If acquire reports busy and this blocks progress, use wait with the same name/mode. It waits without polling and returns a fresh compatibility snapshot, not a lease or queue position. Mail, timeout or cancellation can return while the resource is still busy; check compatible before trying acquire again. Another contender may win. User Stop cancels the wait.'],
    parameters: Type.Object({
      action: StringEnum(['status', 'acquire', 'start', 'renew', 'release', 'reclaim', 'wait'] as const),
      name: Type.Optional(text('Exact cooperative resource name; trim and lowercase normalization are applied. Limit: 96 Unicode characters before and after normalization; no implicit path hierarchy.', 96)),
      purpose: Type.Optional(text('What uses this resource and the expected release condition; at most 240 Unicode characters after trimming.', 240)),
      mode: Type.Optional(StringEnum(['exclusive', 'shared'] as const)),
      leaseId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      ttlMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3_600_000 })),
      startWithinMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
      reason: Type.Optional(text('reclaim only: evidence that expired/orphaned work has stopped; at most 240 Unicode characters after trimming.', 240)),
      confirmStopped: Type.Optional(Type.Boolean({ description: 'reclaim only: assert that you independently verified work stopped. This tool performs no OS cleanup.' })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300_000, default: 60_000, description: 'wait only: maximum event wait; 0 inspects current compatibility without acquiring.' })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: (_id, raw, signal) => {
      const args = raw as WorkerJsonObject;
      return args.action === 'wait' ? waitCall('resources', args, signal) : call('resources', args, signal, args.action !== 'status');
    },
  }];
}
