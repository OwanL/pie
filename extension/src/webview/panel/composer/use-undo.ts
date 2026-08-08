import { useCallback, useReducer } from 'preact/hooks';

interface UndoHistory<T> {
  past: T[];
  present: T;
  future: T[];
}

type UndoAction<T> =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'set'; value: T; checkpoint: boolean }
  | { type: 'reset'; value: T };

export interface UndoControls<T> {
  set: (value: T, checkpoint?: boolean) => void;
  reset: (value: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Small Preact-native undo history for the composer.
 *
 * The previously used `use-undo` package is React-hook based. Its package
 * entrypoint is consumed by the Node test runner without Vite's `react` alias,
 * so it invokes React-compatible hooks against Preact's renderer and fails at
 * runtime. Keeping this tiny state machine local gives both the webview build
 * and tsx tests the same hook implementation.
 */
export function useUndo<T>(initial: T): [UndoHistory<T>, UndoControls<T>] {
  const [history, dispatch] = useReducer(
    (state: UndoHistory<T>, action: UndoAction<T>): UndoHistory<T> => {
      switch (action.type) {
        case 'undo': {
          if (state.past.length === 0) return state;
          const present = state.past[state.past.length - 1];
          return {
            past: state.past.slice(0, -1),
            present,
            future: [state.present, ...state.future],
          };
        }
        case 'redo': {
          if (state.future.length === 0) return state;
          const present = state.future[0];
          return {
            past: [...state.past, state.present],
            present,
            future: state.future.slice(1),
          };
        }
        case 'set':
          if (Object.is(action.value, state.present)) return state;
          return {
            past: action.checkpoint ? [...state.past, state.present] : state.past,
            present: action.value,
            future: [],
          };
        case 'reset':
          return { past: [], present: action.value, future: [] };
      }
    },
    { past: [], present: initial, future: [] },
  );

  const set = useCallback((value: T, checkpoint = false) => {
    dispatch({ type: 'set', value, checkpoint });
  }, []);
  const reset = useCallback((value: T) => {
    dispatch({ type: 'reset', value });
  }, []);
  const undo = useCallback(() => {
    dispatch({ type: 'undo' });
  }, []);
  const redo = useCallback(() => {
    dispatch({ type: 'redo' });
  }, []);

  return [history, {
    set,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  }];
}
