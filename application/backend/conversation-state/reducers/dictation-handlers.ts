import type { ArchState } from '../arch-state.js';
import type { DictationCommand } from '../commands.js';
import type { DictationEvent, Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { dictationActive } from '../../../lib/protocol/dictation.js';

export function cancelDictation(state: ArchState): ReducerResult {
  if (!state.dictation.capture) return { state, effects: [] };
  return { state: { ...state, dictation: { ...state.dictation, phase: 'idle', capture: null, detail: undefined, audioLevel: undefined } },
    effects: [{ kind: 'DictationControl', action: 'cancel', recordingId: state.dictation.recordingId! }] };
}
export function handleDictationCommand(state: ArchState, cmd: DictationCommand): ReducerResult {
  const d = state.dictation;
  if (cmd.kind === 'DictationStart') {
    if (!d.available || dictationActive(d) || !cmd.recordingId || state.sessions.activeSessionPath !== cmd.sessionPath
      || !state.sessions.openTabPaths.includes(cmd.sessionPath)
      || (state.composer.draftTextBySession[cmd.sessionPath] ?? '') !== cmd.draftText
      || !Number.isInteger(cmd.selectionStart) || !Number.isInteger(cmd.selectionEnd)
      || cmd.selectionStart < 0 || cmd.selectionEnd < cmd.selectionStart || cmd.selectionEnd > cmd.draftText.length) return { state, effects: [] };
    return { state: { ...state, dictation: { available: d.available, phase: 'preparing', recordingId: cmd.recordingId,
      sessionPath: cmd.sessionPath, transcript: '', error: null, capture: { corrId: cmd.corrId,
        rendererId: cmd.rendererId, rendererGeneration: cmd.rendererGeneration,
        prefix: cmd.draftText.slice(0, cmd.selectionStart), selectedText: cmd.draftText.slice(cmd.selectionStart, cmd.selectionEnd),
        suffix: cmd.draftText.slice(cmd.selectionEnd), expectedAppliedDraft: cmd.draftText, sequence: -1, hadSpeech: false } } },
      effects: [{ kind: 'DictationControl', action: 'start', recordingId: cmd.recordingId }] };
  }
  if (!d.capture || d.recordingId !== cmd.recordingId
    || d.capture.rendererId !== cmd.rendererId || d.capture.rendererGeneration !== cmd.rendererGeneration) return { state, effects: [] };
  if (cmd.kind === 'DictationCancel') return cancelDictation(state);
  if (d.phase === 'finalizing') return { state, effects: [] };
  return { state: { ...state, dictation: { ...d, phase: 'finalizing', detail: undefined, audioLevel: undefined } },
    effects: [{ kind: 'DictationControl', action: 'stop', recordingId: cmd.recordingId }] };
}
export function handleDictationEvent(state: ArchState, event: DictationEvent): ReducerResult {
  const d = state.dictation;
  if (event.kind === 'DictationAvailabilityChanged') return d.available === event.available ? { state, effects: [] }
    : { state: { ...state, dictation: { ...d, available: event.available } }, effects: [] };
  if (event.kind === 'DictationRendererInvalidated') return d.capture?.rendererId === event.rendererId
    && d.capture.rendererGeneration === event.rendererGeneration ? cancelDictation(state) : { state, effects: [] };
  if (!d.capture || d.recordingId !== event.id || !Number.isSafeInteger(event.sequence) || event.sequence <= d.capture.sequence) return { state, effects: [] };
  const c = { ...d.capture, sequence: event.sequence };
  const o = event.observation;
  if (o.kind === 'level') {
    if (d.phase !== 'recording' || !Number.isFinite(o.level) || o.level < 0 || o.level > 1) return { state, effects: [] };
    return { state: { ...state, dictation: { ...d, capture: c, audioLevel: o.level } }, effects: [] };
  }
  if (o.kind === 'transcript') {
    if ((state.composer.draftTextBySession[d.sessionPath!] ?? '') !== c.expectedAppliedDraft) return cancelDictation(state);
    const text = o.text;
    const region = !text && !c.hadSpeech ? c.selectedText : text;
    c.expectedAppliedDraft = c.prefix + region + c.suffix;
    c.hadSpeech ||= text.length > 0;
    return { state: { ...state, composer: { ...state.composer, draftTextBySession: {
      ...state.composer.draftTextBySession, [d.sessionPath!]: c.expectedAppliedDraft } },
      dictation: { ...d, transcript: text, phase: o.final ? 'idle' : d.phase, capture: o.final ? null : c, detail: undefined, audioLevel: o.final ? undefined : d.audioLevel } }, effects: [] };
  }
  if (o.kind === 'status') return { state: { ...state, dictation: { ...d, capture: c,
    phase: d.phase === 'finalizing' ? 'finalizing' : o.phase, detail: o.detail,
    audioLevel: o.phase === 'recording' && d.phase !== 'finalizing' ? d.audioLevel : undefined } }, effects: [] };
  return { state: { ...state, dictation: { ...d, capture: null, phase: o.kind === 'error' ? 'error' : 'idle',
    error: o.kind === 'error' ? o.message : null, detail: undefined, audioLevel: undefined } }, effects: [] };
}
/** Evaluate semantic changes, not command intent, after ordinary reduction. */
export function reconcileDictation(previous: ArchState, result: ReducerResult, event: Event): ReducerResult {
  let next = result.state;
  if (!next.dictation.capture) return result;
  if (event.kind === 'PendingPathReplaced' && next.dictation.sessionPath === event.oldPendingPath) {
    next = { ...next, dictation: { ...next.dictation, sessionPath: event.newSessionPath } };
  }
  const path = next.dictation.sessionPath!;
  const manualEdit = event.kind === 'Command' && event.cmd.kind === 'SetComposerDraft'
    && event.cmd.sessionPath === path && event.cmd.text !== next.dictation.capture!.expectedAppliedDraft;
  const changedSelection = previous.sessions.activeSessionPath !== next.sessions.activeSessionPath
    && !(event.kind === 'PendingPathReplaced' && previous.sessions.activeSessionPath === event.oldPendingPath
      && next.sessions.activeSessionPath === event.newSessionPath);
  if (manualEdit || changedSelection || !next.sessions.openTabPaths.includes(path)) {
    const cancelled = cancelDictation(next);
    return { state: cancelled.state, effects: [...result.effects, ...cancelled.effects] };
  }
  return next === result.state ? result : { ...result, state: next };
}
