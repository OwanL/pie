import { randomUUID } from 'node:crypto';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { deferTriggerSchema } from './src/types.js';
import type { DeferTriggerParams, TriggerSpec } from './src/types.js';
import { appendTriggerOp, listActiveForSession } from './src/store.js';

/** Honor the host's per-extension toggle (PIE_EXTENSION_TOGGLES_JSON, keyed by
 *  extension id). Mirrors skill-pruner's isExtensionDisabledByToggle so the
 *  Settings → Extensions checkbox actually disables this tool at runtime. */
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

/** Minimal context shape the tool needs: the current session's file path. */
interface ToolExecuteCtx {
  sessionManager: {
    getSessionFile(): string | undefined;
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

/** Validate + coerce a raw triggers array into `TriggerSpec[]`, or return an error string. */
function validateTriggers(raw: unknown): { specs?: TriggerSpec[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'triggers must be a non-empty array of trigger specs.' };
  }
  const specs: TriggerSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'each trigger spec must be an object.' };
    const s = item as Record<string, unknown>;
    if (s.kind !== 'session_finished' && s.kind !== 'timer' && s.kind !== 'user_input') {
      return { error: `trigger kind must be one of session_finished | timer | user_input (got ${String(s.kind)}).` };
    }
    const spec: TriggerSpec = { kind: s.kind };
    if (s.kind === 'session_finished') {
      if (s.sessionPath !== undefined) {
        if (typeof s.sessionPath !== 'string' || s.sessionPath.trim() === '') {
          return { error: 'session_finished.sessionPath must be a non-empty string or omitted.' };
        }
        spec.sessionPath = s.sessionPath;
      }
    } else if (s.kind === 'timer') {
      if (typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms <= 0 || !Number.isInteger(s.ms)) {
        return { error: 'timer.ms must be a positive integer (milliseconds).' };
      }
      spec.ms = s.ms;
    }
    specs.push(spec);
  }
  return { specs };
}

function describeTrigger(specs: TriggerSpec[]): string {
  return specs
    .map((s) => {
      if (s.kind === 'session_finished') {
        return s.sessionPath ? `session_finished(${s.sessionPath})` : 'session_finished(any)';
      }
      if (s.kind === 'timer') return `timer(${s.ms}ms)`;
      return 'user_input';
    })
    .join(' OR ');
}

function renderList(triggers: { id: string; triggers: TriggerSpec[]; note: string; registeredAt: string }[]): string {
  if (triggers.length === 0) return 'No pending deferred triggers for this session.';
  const rows = triggers.map(
    (t) => `  ${t.id}  [${describeTrigger(t.triggers)}]  note: ${t.note || '(none)'}  registered: ${t.registeredAt}`,
  );
  return `Pending deferred triggers (${triggers.length}):\n${rows.join('\n')}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'defer_trigger',
    label: 'Defer / resume',
    description: 'Register, list, or cancel triggers that resume this session after a timer, user input, or another session finishes. Registered triggers use OR semantics.',
    promptSnippet: 'Wait for an asynchronous condition and resume this session when it fires.',
    promptGuidelines: [
      'After defer_trigger register, end the turn; on wake-up re-check the condition and complete or re-register. Prefer specific triggers; session_finished never fires for this session itself.',
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
      const p = (params ?? {}) as DeferTriggerParams;
      if (p.action !== 'register' && p.action !== 'cancel' && p.action !== 'list') {
        return err(`action must be one of register | cancel | list (got ${String(p.action)}).`);
      }

      const sessionPath = ctx?.sessionManager?.getSessionFile();
      if (!sessionPath) {
        return err('no active session path available — cannot determine which session to resume.');
      }

      if (p.action === 'list') {
        const triggers = listActiveForSession(sessionPath);
        return ok(renderList(triggers), { count: triggers.length });
      }

      if (p.action === 'cancel') {
        const targetId = typeof p.triggerId === 'string' && p.triggerId ? p.triggerId : undefined;
        appendTriggerOp({
          op: 'cancel',
          sessionPath,
          ...(targetId ? { targetId } : {}),
          at: new Date().toISOString(),
        });
        return ok(
          targetId
            ? `Cancelled deferred trigger ${targetId} for this session.`
            : 'Cancelled all pending deferred triggers for this session.',
          undefined,
        );
      }

      // register
      const { specs, error } = validateTriggers(p.triggers);
      if (error || !specs) return err(error!);
      const note = typeof p.note === 'string' ? p.note : '';
      const id = randomUUID();
      appendTriggerOp({
        id,
        op: 'register',
        sessionPath,
        triggers: specs,
        note,
        at: new Date().toISOString(),
      });
      return ok(
        `Registered deferred trigger ${id}:\n  [${describeTrigger(specs)}]\n  note: ${note || '(none)'}\n\nYour turn will end now; you will be resumed automatically when the trigger fires. When resumed, re-evaluate the condition and either complete the task or call \`defer_trigger\` with action \`register\` again to keep waiting.`,
        undefined,
      );
    },
  });
}
