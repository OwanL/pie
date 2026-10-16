import type { ArchState } from './arch-state.js';
import type { SnoozedSession } from '../../lib/protocol/session-snooze.js';
import type { ReducerResult } from './reducers/helpers.js';
import { cleanPinnedTabGroups, reconcilePinnedGroups, reorderOpenTabsPinnedFirst, isPendingTabPath } from '../../lib/session-tabs/tab-behavior.js';

export interface SessionSnoozeEntry extends SnoozedSession {
  index: number;
  pinnedIndex: number;
  group: string[];
  reservationId?: string;
}
export type SessionSnoozeEvent =
  | { kind: 'SessionSnoozeReleaseResult'; sessionPath: string; reservationId: string; ok: boolean }
  | { kind: 'SessionSnoozeRequested'; sessionPath: string; wakeAt: number; now: number; deferredTarget: boolean }
  | { kind: 'SessionSnoozeReservationResult'; sessionPath: string; reservationId: string; ok: boolean; now: number }
  | { kind: 'SessionSnoozeRestoreRequested'; sessionPath: string }
  | { kind: 'SessionSnoozeTimerFired'; now: number }
  | { kind: 'SessionSnoozesRestored'; entries: Record<string, SessionSnoozeEntry>; now: number };

export function normalizeStoredSnoozes(value: unknown, restorable: (path: string) => boolean): Record<string, SessionSnoozeEntry> {
  const entries: Record<string, SessionSnoozeEntry> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return entries;
  for (const [path, raw] of Object.entries(value)) {
    if (!path || isPendingTabPath(path) || !raw || typeof raw !== 'object' || !restorable(path)) continue;
    const entry = raw as SessionSnoozeEntry;
    if (!Number.isSafeInteger(entry.wakeAt) || entry.wakeAt < 0 || typeof entry.name !== 'string') continue;
    entries[path] = { path, name: entry.name, wakeAt: entry.wakeAt,
      index: Number.isSafeInteger(entry.index) && entry.index >= 0 ? entry.index : 0,
      pinnedIndex: Number.isSafeInteger(entry.pinnedIndex) ? entry.pinnedIndex : -1,
      group: Array.isArray(entry.group) ? entry.group.filter((p): p is string => typeof p === 'string' && !isPendingTabPath(p)) : [],
    };
  }
  return entries;
}

export function canSnoozeSession(state: ArchState, path: string): boolean {
  return !Object.values(state.sessions.snoozeReleases).some((release) => release.sessionPath === path)
    && !isPendingTabPath(path) && state.sessions.openTabPaths.includes(path)
    && !state.sessions.runningSessionPaths.includes(path)
    && !state.sessions.capabilitiesBySession[path]?.billableActivity
    && !state.livePipeline.turnsBySession[path]
    && !Object.keys(state.settings.pendingExtensionUIRequestsBySession[path] ?? {}).length
    && !Object.values(state.operations).some((op) => !op.terminal &&
      (op.session.pendingPath === path || op.session.resolvedPath === path || op.session.sourcePath === path))
    && ![...Object.values(state.pending.ops), ...Object.values(state.pending.promoted)].some((op) => op.sessionPath === path)
    && !(state.pending.sendQueueBySession[path]?.length)
    && !(state.pending.backendReadyQueueBySession[path]?.length)
    && !state.pending.deferredSetModelBySession[path]
    && !Object.values(state.pending.setModelByCorrId).some((op) => op.sessionPath === path)
    && !Object.values(state.pending.extensionUiResponseByCorrId).some((op) => op.sessionPath === path);
}

function wake(state: ArchState, path: string): ArchState {
  const entry = state.sessions.snoozedBySession[path];
  if (!entry) return state;
  const entries = { ...state.sessions.snoozedBySession };
  delete entries[path];
  const open = state.sessions.openTabPaths.filter((p) => p !== path);
  // Restored ordinary tabs return at the right edge. Pins and groups retain
  // their recovery intent and remain in the pinned prefix below.
  open.push(path);
  const pinned = [...state.sessions.pinnedTabPaths];
  const absentPinnedBefore = Object.values(entries).filter((e) => e.pinnedIndex >= 0 && e.pinnedIndex < entry.pinnedIndex).length;
  if (entry.pinnedIndex >= 0 && !pinned.includes(path)) pinned.splice(Math.min(Math.max(0, entry.pinnedIndex - absentPinnedBefore), pinned.length), 0, path);
  const group = entry.group.filter((p) => pinned.includes(p));
  const groups = group.length >= 2 ? [group, ...state.sessions.pinnedTabGroups.map((g) => g.filter((p) => !group.includes(p)))] : state.sessions.pinnedTabGroups;
  const reconciled = reconcilePinnedGroups(pinned, groups);
  return { ...state, sessions: { ...state.sessions, snoozedBySession: entries,
    ...reorderOpenTabsPinnedFirst(open, reconciled.pinnedTabPaths), pinnedTabGroups: reconciled.pinnedTabGroups,
  } };
}

export function snoozeEffects(state: ArchState): ReducerResult['effects'] {
  const wakeAt = Math.min(...Object.values(state.sessions.snoozedBySession).map((e) => e.wakeAt));
  return [{ kind: 'PersistTabs', corrId: 'session-snooze', openTabPaths: state.sessions.openTabPaths,
    activeSessionPath: state.sessions.activeSessionPath, pinnedTabPaths: state.sessions.pinnedTabPaths,
    pinnedTabGroups: state.sessions.pinnedTabGroups, snoozedBySession: state.sessions.snoozedBySession },
  { kind: 'ScheduleSessionSnooze', corrId: 'session-snooze', wakeAt: Number.isFinite(wakeAt) ? wakeAt : null }];
}

export function reduceSessionSnooze(state: ArchState, event: SessionSnoozeEvent): ReducerResult {
  if (event.kind === 'SessionSnoozeReleaseResult') return { state, effects: [] };
  let next = state;
  if (event.kind === 'SessionSnoozeRequested') {
    const path = event.sessionPath;
    if (event.deferredTarget || !Number.isSafeInteger(event.wakeAt) || event.wakeAt <= event.now || !canSnoozeSession(state, path)) return { state, effects: [] };
    const sequence = state.sessions.snoozeSequence + 1;
    const reservationId = `session-snooze:${sequence}`;
    const previous = state.sessions.pendingSnoozes[path];
    return { state: { ...state, sessions: { ...state.sessions, snoozeSequence: sequence,
      pendingSnoozes: { ...state.sessions.pendingSnoozes, [path]: { reservationId, wakeAt: event.wakeAt } } } },
      effects: [...(previous ? [{ kind: 'ReleaseSessionSnooze' as const, corrId: previous.reservationId, sessionPath: path, reservationId: previous.reservationId }] : []),
        { kind: 'ReserveSessionSnooze', corrId: reservationId, sessionPath: path, reservationId, wakeAt: event.wakeAt }] };
  }
  if (event.kind === 'SessionSnoozeReservationResult') {
    const path = event.sessionPath;
    const pending = state.sessions.pendingSnoozes[path];
    if (!pending || pending.reservationId !== event.reservationId) return { state, effects:
      state.sessions.snoozedBySession[path]?.reservationId === event.reservationId ? [] : [
        { kind: 'ReleaseSessionSnooze', corrId: event.reservationId, sessionPath: path, reservationId: event.reservationId }] };
    const pendingSnoozes = { ...state.sessions.pendingSnoozes };
    delete pendingSnoozes[path];
    state = { ...state, sessions: { ...state.sessions, pendingSnoozes } };
    next = state;
    if (!event.ok || pending.wakeAt <= event.now || !canSnoozeSession(state, path)) return { state, effects: [
      { kind: 'ReleaseSessionSnooze', corrId: event.reservationId, sessionPath: path, reservationId: event.reservationId }] };
    const open = state.sessions.openTabPaths;
    const index = open.indexOf(path);
    let savedIndex = index;
    let savedPinnedIndex = state.sessions.pinnedTabPaths.indexOf(path);
    for (const entry of Object.values(state.sessions.snoozedBySession).sort((a, b) => a.index - b.index)) if (entry.index <= savedIndex) savedIndex++;
    if (savedPinnedIndex >= 0) for (const entry of Object.values(state.sessions.snoozedBySession).filter((e) => e.pinnedIndex >= 0).sort((a, b) => a.pinnedIndex - b.pinnedIndex)) if (entry.pinnedIndex <= savedPinnedIndex) savedPinnedIndex++;
    const savedGroup = Object.values(state.sessions.snoozedBySession).find((e) => e.group.includes(path))?.group
      ?? state.sessions.pinnedTabGroups.find((g) => g.includes(path)) ?? [];
    const remaining = open.filter((p) => p !== path);
    const pinned = state.sessions.pinnedTabPaths.filter((p) => p !== path);
    next = { ...state, sessions: { ...state.sessions, openTabPaths: remaining, pinnedTabPaths: pinned,
      pinnedTabGroups: cleanPinnedTabGroups(state.sessions.pinnedTabGroups, pinned),
      activeSessionPath: state.sessions.activeSessionPath === path ? (remaining[Math.min(index, remaining.length - 1)] ?? null) : state.sessions.activeSessionPath,
      snoozedBySession: { ...state.sessions.snoozedBySession, [path]: { path,
        name: state.sessions.sessions.find((s) => s.path === path)?.name ?? 'Session', wakeAt: pending.wakeAt, reservationId: event.reservationId,
        index: savedIndex, pinnedIndex: savedPinnedIndex, group: savedGroup,
      } },
    } };
  } else if (event.kind === 'SessionSnoozeRestoreRequested') {
    next = wake(state, event.sessionPath);
  } else {
    if (event.kind === 'SessionSnoozesRestored') {
      const pinned = state.sessions.pinnedTabPaths.filter((p) => !event.entries[p]);
      next = { ...state, sessions: { ...state.sessions, snoozedBySession: event.entries,
        openTabPaths: state.sessions.openTabPaths.filter((p) => !event.entries[p]), pinnedTabPaths: pinned,
        pinnedTabGroups: cleanPinnedTabGroups(state.sessions.pinnedTabGroups, pinned),
        activeSessionPath: state.sessions.activeSessionPath && event.entries[state.sessions.activeSessionPath] ? null : state.sessions.activeSessionPath,
      } };
    }
    for (const entry of Object.values(next.sessions.snoozedBySession)) if (entry.wakeAt <= event.now) next = wake(next, entry.path);
  }
  if (next === state) return { state, effects: event.kind === 'SessionSnoozeTimerFired' ? snoozeEffects(state).filter((e) => e.kind === 'ScheduleSessionSnooze') : [] };
  const effects = snoozeEffects(next);
  for (const entry of Object.values(state.sessions.snoozedBySession)) {
    if (!next.sessions.snoozedBySession[entry.path] && entry.reservationId) effects.push({
      kind: 'ReleaseSessionSnooze', corrId: entry.reservationId, sessionPath: entry.path, reservationId: entry.reservationId,
    });
  }
  if (next.sessions.activeSessionPath && next.sessions.activeSessionPath !== state.sessions.activeSessionPath) effects.push({
    kind: 'NotifySessionViewed', corrId: 'session-snooze', sessionPath: next.sessions.activeSessionPath, previousSessionPath: state.sessions.activeSessionPath,
  }, {
    kind: 'SelectSnoozeSuccessor', corrId: 'session-snooze', sessionPath: next.sessions.activeSessionPath,
  });
  return { state: next, effects };
}
