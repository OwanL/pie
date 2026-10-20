import { createContext } from 'preact';

/** Explicit host tombstones, never inferred from a session's live catalog. */
export const RemovedProvidersContext = createContext<readonly string[]>([]);
