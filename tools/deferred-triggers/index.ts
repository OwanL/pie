import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { guardCommand } from '../../extensions/safeguard/index.js';
import { validateWakeConditions } from '../../shared/wake-conditions.js';
import { deferTriggerSchema } from './src/types.js';
import type { ActiveTrigger, DeferTriggerParams, TriggerSpec } from './src/types.js';
import { appendTriggerOp, listActiveForSession } from './src/store.js';

/** Honor the host's per-extension toggle (PIE_EXTENSION_TOGGLES_JSON, keyed by
 * extension id). Mirrors skill-pruner's toggle handling. */
function isDisabledByToggle(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['deferred-triggers'] === false;
  } catch {
    return false;
  }
}

/** Minimal context shape used by the deferred-trigger tool. */
interface ToolExecuteCtx {
  sessionManager: {
    getSessionFile(): string | undefined;
  };
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: string): void;
  };
}

function ok(text: string, details?: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    isError: false as const,
  };
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: `defer_trigger error: ${message}` }],
    details: { error: message },
    isError: true as const,
  };
}

function registrationCwd(ctx: ToolExecuteCtx): string {
  return path.resolve(typeof ctx.cwd === 'string' && ctx.cwd.trim() ? ctx.cwd : process.cwd());
}

async function checkCommandSafety(specs: TriggerSpec[], ctx: ToolExecuteCtx): Promise<string | undefined> {
  for (const spec of specs) {
    if (spec.kind !== 'command') continue;
    const result = await guardCommand(spec.command, {
      cwd: spec.cwd,
      hasUI: ctx.hasUI === true,
      ui: ctx.ui ?? {
        confirm: async () => false,
        notify: () => undefined,
      },
    });
    if (result?.block) return result.reason;
  }
  return undefined;
}

function describeTrigger(spec: TriggerSpec): string {
  if (spec.kind === 'session_finished') {
    return spec.sessionPath ? `session_finished(${spec.sessionPath})` : 'session_finished(any)';
  }
  if (spec.kind === 'timer') return `timer(${spec.ms}ms)`;
  if (spec.kind === 'user_input') return 'user_input';
  return `command(${spec.command}; cwd=${spec.cwd}; every=${spec.intervalMs}ms; timeout=${spec.timeoutMs}ms)`;
}

function describeTriggers(specs: TriggerSpec[]): string {
  return specs.map(describeTrigger).join(' OR ');
}

function renderList(triggers: ActiveTrigger[]): string {
  if (triggers.length === 0) return 'No pending deferred triggers for this session.';
  const rows = triggers.map((t) => {
    const message = t.message.trim() || t.note.trim();
    const target = t.targetSession === t.sessionPath ? 'caller' : t.targetSession;
    return `  ${t.id}  [${describeTriggers(t.triggers)}]  target: ${target}  delivery: ${t.deliveryState}${t.deliveryDetail ? ` (${t.deliveryDetail})` : ''}  message: ${message || '(none)'}  registered: ${t.registeredAt}`;
  });
  return `Pending deferred triggers (${triggers.length}):\n${rows.join('\n')}`;
}

function getSessionPath(ctx: ToolExecuteCtx): string | undefined {
  return ctx?.sessionManager?.getSessionFile();
}

function readMessage(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readTargetSession(value: unknown, caller: string): { target?: string; error?: string } {
  if (value === undefined) return { target: caller };
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: 'targetSession must be a non-empty persisted session path when provided.' };
  }
  return { target: value.trim() };
}

async function registerWake(
  rawTriggers: unknown,
  message: string,
  creatorSession: string,
  targetSession: string,
  ctx: ToolExecuteCtx,
): Promise<{ id: string; specs: TriggerSpec[] } | { error: string }> {
  const { specs, error } = validateWakeConditions(rawTriggers, { registrationCwd: registrationCwd(ctx) });
  if (error || !specs) return { error: error ?? 'invalid wake conditions.' };

  const safetyError = await checkCommandSafety(specs, ctx);
  if (safetyError) return { error: safetyError };

  const id = randomUUID();
  try {
    appendTriggerOp({
      id,
      op: 'register',
      sessionPath: creatorSession,
      targetSession,
      triggers: specs,
      message,
      at: new Date().toISOString(),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { error: `could not persist the deferred trigger: ${detail}` };
  }
  return { id, specs };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'defer_trigger',
    label: 'Defer / resume',
    description: 'Register, list, or cancel durable triggers that deliver a message to a session after a timer, user input, another session finishes, or a periodic predicate. Registration never ends this turn. All actions require the calling session\'s persisted JSONL path, so in-memory subagent sessions are not supported.',
    promptSnippet: 'Register an asynchronous condition and message for a session to receive later.',
    promptGuidelines: [
      'Use defer_trigger action register to persist a trigger and required message; registration does not end the current turn, so continue working or finish normally.',
      'Every defer_trigger action requires the calling session\'s persisted JSONL path; in-memory subagent sessions cannot register, list, or cancel triggers.',
      'Use targetSession only with an explicitly persisted session path. The target must be open when delivery occurs; a closed or unavailable target is not redirected to the caller.',
      'Use defer_trigger action list or cancel to manage triggers created by the current session. On a wake, re-check the task and either complete it or register another trigger.',
      'Conditions in one registration use OR semantics. A command predicate exits 0 when satisfied and 1 when not yet satisfied; other exits are evaluation errors and are retried periodically.',
    ],
    parameters: deferTriggerSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ToolExecuteCtx,
    ) {
      if (isDisabledByToggle()) {
        return err('The deferred-triggers extension is disabled. Enable it in Settings → Extensions to defer/resume sessions.');
      }
      const p = (params ?? {}) as Partial<DeferTriggerParams>;
      if (p.action !== 'register' && p.action !== 'cancel' && p.action !== 'list') {
        return err(`action must be one of register | cancel | list (got ${String(p.action)}).`);
      }

      const creatorSession = getSessionPath(ctx);
      if (!creatorSession) {
        return err('no active session path available — cannot determine trigger ownership.');
      }

      if (p.action === 'list') {
        const triggers = listActiveForSession(creatorSession);
        return ok(renderList(triggers), { count: triggers.length });
      }

      if (p.action === 'cancel') {
        if (p.triggerId !== undefined && (typeof p.triggerId !== 'string' || !p.triggerId.trim())) {
          return err('triggerId must be a non-empty string when provided; omit it to cancel all triggers owned by this session.');
        }
        const targetId = p.triggerId as string | undefined;
        if (targetId) {
          const owned = listActiveForSession(creatorSession).some((trigger) => trigger.id === targetId);
          if (!owned) {
            return err(`deferred trigger ${targetId} is not owned by the current session.`);
          }
        }
        try {
          appendTriggerOp({
            op: 'cancel',
            sessionPath: creatorSession,
            ...(targetId ? { targetId } : {}),
            at: new Date().toISOString(),
          });
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          return err(`could not persist cancellation: ${detail}`);
        }
        return ok(
          targetId
            ? `Cancelled deferred trigger ${targetId} for this session.`
            : 'Cancelled all pending deferred triggers for this session.',
        );
      }

      const message = readMessage(p.message);
      if (!message.trim()) {
        return err('message is required and must be a non-empty string for action register.');
      }
      const target = readTargetSession(p.targetSession, creatorSession);
      if (target.error || !target.target) return err(target.error ?? 'targetSession is invalid.');

      const registration = await registerWake(
        p.triggers,
        message,
        creatorSession,
        target.target,
        ctx,
      );
      if ('error' in registration) return err(registration.error);
      return ok(
        `Registered deferred trigger ${registration.id}:\n  [${describeTriggers(registration.specs)}]\n  target: ${target.target}\n  message: ${message}\n\nThe current turn continues; the target session must be open when the trigger fires.`,
        { id: registration.id },
      );
    },
  });
}
