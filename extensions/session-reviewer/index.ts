import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { sessionReviewSchema } from './src/types.js';
import type { SessionReviewParams } from './src/types.js';
import { appendReview, readOpenTabs, readReviews } from './src/store.js';
import { parseSessionTranscript, renderTranscript } from './src/transcript.js';

/** Honor the host's per-extension toggle (PIE_EXTENSION_TOGGLES_JSON, keyed by
 *  extension id). Mirrors skill-pruner's isExtensionDisabledByToggle so the
 *  Settings → Extensions checkbox actually disables this tool at runtime. */
function isDisabledByToggle(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['session-reviewer'] === false;
  } catch {
    return false;
  }
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
    content: [{ type: 'text' as const, text: `session_review error: ${message}` }],
    details: { error: message },
    isError: true as const,
  };
}

/** Render the open-sessions list with review status as a compact table. */
function renderOpenList(
  tabs: { path: string; name: string; messageCount?: number; modifiedAt?: string; done?: boolean; rating?: number; completion?: string; reviewReason?: string; pinned?: boolean; isSelf?: boolean; isRunning?: boolean }[],
): string {
  if (tabs.length === 0) {
    return 'No open sessions are currently pushed from the host (PIE_OPEN_TABS empty/unset). Open sessions as tabs in the app first.';
  }
  const rows = tabs.map((t) => {
    const done = t.done ? '✓' : '○';
    const rating = typeof t.rating === 'number' ? `${t.rating}/5` : '—';
    const completion = t.completion ?? '—';
    const reason = t.reviewReason ? truncate(t.reviewReason, 50) : '';
    const name = truncate(t.name || '(unnamed)', 30);
    const msgs = typeof t.messageCount === 'number' ? String(t.messageCount) : '?';
    const pin = t.pinned ? '📌 ' : '';
    const self = t.isSelf ? '★ ' : '';
    const run = t.isRunning ? '▶ ' : '';
    return `${done} ${rating} ${completion.padEnd(7)} msgs=${msgs.padStart(3)}  ${self}${run}${pin}${name}${reason ? `  — ${reason}` : ''}`;
  });
  const header = `Open sessions (${tabs.length}):
  done rating compl  msgs   name`;
  return [header, ...rows.map((r) => `  ${r}`), '', 'Paths (use as sessionPath):', ...tabs.map((t) => `  ${t.path}${t.pinned ? '  (pinned)' : ''}${t.isSelf ? '  (self)' : ''}${t.isRunning ? '  (running)' : ''}`)].join('\n');
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n) + '…';
}

/** Minimal context shape the tool needs: the current session's file path.
 *  Provided by the pi runtime to every tool's `execute` (same shape the
 *  deferred-triggers extension relies on). Used only by `closeSelf`. */
interface ToolExecuteCtx {
  sessionManager: {
    getSessionFile(): string | undefined;
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'session_review',
    label: 'Session review',
    description: 'List open sessions, read transcripts, or record a rating/completion review; done=true closes the tab. Use closeSelf to close the current (reviewer) session once its review work is complete. Use only for session-evaluation tasks.',
    promptSnippet: 'List, inspect, and review open app sessions.',
    promptGuidelines: [
      'For session_review, list before reading, read before judging, record reviews directly (no user confirmation needed), and only close conclusively finished sessions. Use closeSelf as the final step to close this reviewer session once all reviews are recorded.',
    ],
    parameters: sessionReviewSchema,

    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolExecuteCtx) {
      if (isDisabledByToggle()) {
        return err('The session-reviewer extension is disabled. Enable it in Settings → Extensions to list/read/review sessions.');
      }
      const p = params as SessionReviewParams;

      if (p.action === 'listOpen') {
        const tabs = readOpenTabs();
        const reviews = readReviews();
        // Resolve this (reviewer) session's own path so listOpen can mark it
        // `(self)` — the skill skips reviewing itself and closes it via
        // closeSelf at the end.
        const selfPath = ctx?.sessionManager?.getSessionFile();
        // Prefer the sidecar's latest review (the tool is the writer; the host
        // push may lag one refresh) but fall back to the pushed summary.
        const merged = tabs.map((t) => {
          const r = reviews.get(t.path);
          return {
            ...t,
            isSelf: !!selfPath && t.path === selfPath,
            ...(r ? { done: r.done, rating: r.rating, completion: r.completion, reviewReason: r.reason } : {}),
          };
        });
        return ok(renderOpenList(merged), { count: merged.length });
      }

      if (p.action === 'getTranscript') {
        if (!p.sessionPath) return err('getTranscript requires sessionPath (from listOpen).');
        const maxTurns = typeof p.maxTurns === 'number' ? p.maxTurns : 40;
        try {
          const parsed = parseSessionTranscript(p.sessionPath, maxTurns);
          // The rendered transcript is already the model-facing payload. Do not
          // persist the same parsed messages again in tool details.
          return ok(renderTranscript(parsed), {
            sessionPath: p.sessionPath,
            maxTurns,
            returnedTurns: parsed.turns.length,
            truncated: parsed.truncated,
          });
        } catch (e) {
          return err((e as Error).message);
        }
      }

      if (p.action === 'setReview') {
        if (!p.sessionPath) return err('setReview requires sessionPath (from listOpen).');
        if (typeof p.done !== 'boolean') return err('setReview requires done (boolean).');
        if (typeof p.rating !== 'number' || p.rating < 1 || p.rating > 5 || !Number.isInteger(p.rating)) {
          return err('setReview requires rating (integer 1–5).');
        }
        if (p.completion !== 'fully' && p.completion !== 'partial' && p.completion !== 'setback') {
          return err('setReview requires completion (fully | partial | setback).');
        }
        const reason = typeof p.reason === 'string' ? p.reason : '';
        // Multi-reviewer provenance (optional): validate shape and reject
        // malformed input so the sidecar never stores junk provenance.
        const rawBuckets = p.reviewerBuckets;
        const reviewerBuckets = Array.isArray(rawBuckets) && rawBuckets.every((b) => typeof b === 'string')
          ? (rawBuckets as string[])
          : undefined;
        if (rawBuckets !== undefined && reviewerBuckets === undefined) {
          return err('setReview reviewerBuckets must be an array of strings.');
        }
        const rawCount = p.reviewerCount;
        const reviewerCount = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0
          ? rawCount
          : undefined;
        if (rawCount !== undefined && reviewerCount === undefined) {
          return err('setReview reviewerCount must be a non-negative integer.');
        }
        const record = {
          sessionPath: p.sessionPath,
          done: p.done,
          rating: p.rating,
          completion: p.completion,
          reason,
          evaluatedAt: new Date().toISOString(),
          ...(reviewerBuckets !== undefined ? { reviewerBuckets } : {}),
          ...(reviewerCount !== undefined ? { reviewerCount } : {}),
        };
        try {
          const file = appendReview(record);
          const closeNote = p.done
            ? "\nThe session's tab will be closed (same as a user closing it, pinned tabs included) — this cleans up the tab once the host refreshes."
            : '';
          const provenance = [
            reviewerBuckets ? `reviewerBuckets=[${reviewerBuckets.join(',')}]` : '',
            reviewerCount !== undefined ? `reviewerCount=${reviewerCount}` : '',
          ].filter(Boolean).join('  ');
          const provenanceLine = provenance ? `\n  ${provenance}` : '';
          return ok(
            `Recorded review for ${p.sessionPath}:\n  done=${p.done} rating=${p.rating}/5 completion=${p.completion}\n  reason: ${reason || '(none)'}${provenanceLine}\nStored in ${file}.${closeNote}`,
            record,
          );
        } catch (e) {
          return err((e as Error).message);
        }
      }

      if (p.action === 'closeSelf') {
        // Resolve the current (reviewer) session's path from the runtime
        // context — the caller never passes its own path. Writes a `done: true`
        // review marked `selfClose: true` so the host's auto-close closes this
        // tab once the turn ends (running sessions are skipped until idle),
        // while the host skips recording a self-rating in agent-review
        // analytics (a session rating itself is not an objective signal).
        const sessionPath = ctx?.sessionManager?.getSessionFile();
        if (!sessionPath) {
          return err('closeSelf could not determine the current session path (no active session).');
        }
        const reason = typeof p.reason === 'string' && p.reason.trim()
          ? p.reason
          : 'Session-review skill complete: evaluated all open sessions and self-closed.';
        const record = {
          sessionPath,
          done: true,
          rating: 3,
          completion: 'fully' as const,
          reason,
          evaluatedAt: new Date().toISOString(),
          selfClose: true,
        };
        try {
          const file = appendReview(record);
          return ok(
            `Recorded a self-close review for this session.\n  done=true completion=fully\n  reason: ${reason}\nStored in ${file}.\n\nThe host will close this tab automatically once the current turn ends. End your turn now — give your final summary and stop calling tools.`,
            record,
          );
        } catch (e) {
          return err((e as Error).message);
        }
      }

      return err(`unknown action: ${String(p.action)}`);
    },
  });
}