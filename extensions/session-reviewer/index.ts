import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { sessionReviewSchema } from './src/types.js';
import type { SessionReviewParams } from './src/types.js';
import { appendReview, readOpenTabs, readReviews } from './src/store.js';
import { parseSessionTranscript, renderTranscript } from './src/transcript.js';

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
  tabs: { path: string; name: string; messageCount?: number; modifiedAt?: string; done?: boolean; rating?: number; completion?: string; reviewReason?: string }[],
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
    return `${done} ${rating} ${completion.padEnd(7)} msgs=${msgs.padStart(3)}  ${name}${reason ? `  — ${reason}` : ''}`;
  });
  const header = `Open sessions (${tabs.length}):\n  done rating compl  msgs   name`;
  return [header, ...rows.map((r) => `  ${r}`), '', 'Paths (use as sessionPath):', ...tabs.map((t) => `  ${t.path}`)].join('\n');
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n) + '…';
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'session_review',
    label: 'Session review',
    description:
      'Evaluate and review the currently-open sessions in the app: list open sessions with their review status, read a session\'s inputs/outputs transcript, and record a done/rating/completion/reason review. Use the evaluate-sessions skill for the full rubric and flow.',
    promptSnippet:
      'List/read/review the app\'s currently-open sessions. listOpen shows open sessions + review status; getTranscript reads a session JSONL; setReview records done + 1–5 rating + completion (fully/partial/setback) + reason.',
    promptGuidelines: [
      'Call listOpen first to see which sessions are currently open and which are already done.',
      'For each non-done open session, call getTranscript to read its inputs/outputs, judge completeness against the user\'s last intent, then call setReview with done + a 1–5 rating + completion (fully/partial/setback) + reason.',
      'Before finalizing a session\'s review, use the ask_user tool to check with the user — present your evaluation (completion + proposed rating + reason) and confirm their take. Adjust based on their reply.',
      'completion: fully = task completed; partial = work done but unresolved; setback = left things worse (regression/failed approach worth revisiting).',
      'Only mark a session done when its task is genuinely complete or conclusively stopped — never mark an in-progress/uncertain session done.',
      'Report a final summary table (session → done/rating/completion) after reviewing all sessions.',
    ],
    parameters: sessionReviewSchema,

    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
      const p = params as SessionReviewParams;

      if (p.action === 'listOpen') {
        const tabs = readOpenTabs();
        const reviews = readReviews();
        // Prefer the sidecar's latest review (the tool is the writer; the host
        // push may lag one refresh) but fall back to the pushed summary.
        const merged = tabs.map((t) => {
          const r = reviews.get(t.path);
          return r
            ? { ...t, done: r.done, rating: r.rating, completion: r.completion, reviewReason: r.reason }
            : t;
        });
        return ok(renderOpenList(merged), { count: merged.length });
      }

      if (p.action === 'getTranscript') {
        if (!p.sessionPath) return err('getTranscript requires sessionPath (from listOpen).');
        const maxTurns = typeof p.maxTurns === 'number' ? p.maxTurns : 40;
        try {
          const parsed = parseSessionTranscript(p.sessionPath, maxTurns);
          return ok(renderTranscript(parsed), parsed);
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
        const record = {
          sessionPath: p.sessionPath,
          done: p.done,
          rating: p.rating,
          completion: p.completion,
          reason,
          evaluatedAt: new Date().toISOString(),
        };
        try {
          const file = appendReview(record);
          return ok(
            `Recorded review for ${p.sessionPath}:\n  done=${p.done} rating=${p.rating}/5 completion=${p.completion}\n  reason: ${reason || '(none)'}\nStored in ${file}. The session list refreshes shortly.`,
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