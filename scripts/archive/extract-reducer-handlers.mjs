/**
 * ⚠️ ARCHIVED one-shot codemod — completed 2026-06-25.
 * Target reducer-handler extraction is DONE; re-running uses whitespace-
 * sensitive `src.includes(block)` and prints "Done" even when it no-ops.
 * Kept for history only.
 */
import fs from 'node:fs';

const FILE = 'extension/src/host/core/reducer.ts';
let src = fs.readFileSync(FILE, 'utf-8');

// Extract handleSendResult
const sendResultBlock = `    case 'SendResult': {
      const pending = state.pending.ops[event.corrId];
      if (!pending) return { state, effects: [] };

      const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

      if (event.ok) {
        // Success: clear composer inputs directly + remove pending op
        const nextState = produce(state, (draft) => {
          draft.pending.ops = restOps;
          delete draft.composer.pendingComposerInputsBySession[pending.sessionPath];
        });
        return { state: nextState, effects: [] };
      }

      // Failure: rollback the optimistic user message + restore previous summary
      const effects: Effect[] = [];

      const nextState = produce(state, (draft) => {
        draft.pending.ops = restOps;
        // Remove optimistic message from transcript
        removeMessage(draft, pending.sessionPath, pending.localId);
        // Set notice
        draft.settings.notice = \`Failed to send message: \${event.error ?? 'unknown error'}\`;
        // Restore session summary if we had one
        if (pending.previousSummary) {
          const idx = draft.sessions.sessions.findIndex((s) => s.path === pending.previousSummary!.path);
          if (idx >= 0) {
            draft.sessions.sessions[idx] = pending.previousSummary;
          } else {
            draft.sessions.sessions.push(pending.previousSummary);
          }
        }
      });

      return { state: nextState, effects };
    }`;

const sendResultFn = `function handleSendResult(state: ArchState, event: Extract<Event, { kind: 'SendResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId];
  if (!pending) return { state, effects: [] };

  const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

  if (event.ok) {
    // Success: clear composer inputs directly + remove pending op
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      delete draft.composer.pendingComposerInputsBySession[pending.sessionPath];
    });
    return { state: nextState, effects: [] };
  }

  // Failure: rollback the optimistic user message + restore previous summary
  const effects: Effect[] = [];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    // Remove optimistic message from transcript
    removeMessage(draft, pending.sessionPath, pending.localId);
    // Set notice
    draft.settings.notice = \`Failed to send message: \${event.error ?? 'unknown error'}\`;
    // Restore session summary if we had one
    if (pending.previousSummary) {
      const idx = draft.sessions.sessions.findIndex((s) => s.path === pending.previousSummary!.path);
      if (idx >= 0) {
        draft.sessions.sessions[idx] = pending.previousSummary;
      } else {
        draft.sessions.sessions.push(pending.previousSummary);
      }
    }
  });

  return { state: nextState, effects };
}
`;

if (src.includes(sendResultBlock)) {
  src = src.replace(sendResultBlock, `    case 'SendResult': {\n      return handleSendResult(state, event);\n    }`);
  // Insert function before export function reducer
  src = src.replace('export function reducer', sendResultFn + 'export function reducer');
  console.log('Extracted handleSendResult');
} else {
  console.log('WARNING: Could not find SendResult block');
}

// Extract handleEditResult
const editResultBlock = `    case 'EditResult': {
      const pending = state.pending.ops[event.corrId];
      if (!pending) return { state, effects: [] };

      const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

      if (event.ok) {
        const nextState = {
          ...state,
          pending: { ...state.pending, ops: restOps },
        };
        return { state: nextState, effects: [] };
      }

      // Failure: rollback the optimistic edit message + notify user
      const effects: Effect[] = [];

      const nextState = produce(state, (draft) => {
        draft.pending.ops = restOps;
        removeMessage(draft, pending.sessionPath, pending.localId);
        draft.settings.notice = \`Failed to edit message: \${event.error ?? 'unknown error'}\`;
      });

      return { state: nextState, effects };
    }`;

const editResultFn = `function handleEditResult(state: ArchState, event: Extract<Event, { kind: 'EditResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId];
  if (!pending) return { state, effects: [] };

  const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

  if (event.ok) {
    const nextState = {
      ...state,
      pending: { ...state.pending, ops: restOps },
    };
    return { state: nextState, effects: [] };
  }

  // Failure: rollback the optimistic edit message + notify user
  const effects: Effect[] = [];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    removeMessage(draft, pending.sessionPath, pending.localId);
    draft.settings.notice = \`Failed to edit message: \${event.error ?? 'unknown error'}\`;
  });

  return { state: nextState, effects };
}
`;

if (src.includes(editResultBlock)) {
  src = src.replace(editResultBlock, `    case 'EditResult': {\n      return handleEditResult(state, event);\n    }`);
  src = src.replace('export function reducer', editResultFn + 'export function reducer');
  console.log('Extracted handleEditResult');
} else {
  console.log('WARNING: Could not find EditResult block');
}

fs.writeFileSync(FILE, src);
console.log('Done');
