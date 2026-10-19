import { WorkerLiveDetailStore, type WorkerLiveDetailStoreOptions } from '../worker-live-detail-store';

/** Exercise the real baseline cursor, settling each admitted transport frame.
 * No pages or canonical state are manufactured by the fixture. */
export function createSettledDetailStore(options: Omit<WorkerLiveDetailStoreOptions, 'onDrain'>) {
  const pending: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const store = new WorkerLiveDetailStore({
    ...options,
    emit(frame, onSettled) {
      const accepted = options.emit(frame);
      if (accepted && onSettled) pending.push(() => onSettled({ status: 'sent' }));
      return accepted;
    },
    onDrain(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  return {
    store,
    async settle() {
      do {
        pending.shift()?.();
        for (const listener of listeners) listener();
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (pending.length > 0);
    },
  };
}
