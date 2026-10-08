/** Cold backend/worker initialization includes verified SDK loading and services.
 * Keep this separate from hot acknowledgements, heartbeats, and request deadlines.
 */
export const RUNTIME_INITIALIZATION_TIMEOUT_MS = 120_000;
