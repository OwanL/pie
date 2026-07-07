/** Webview-accessible entry point for the canonical error helpers.
 *  Re-exports from the root `shared/` package. Webview code imports from
 *  '../shared/error-message' (resolved relative to extension/src/shared). */
export { toErrorMessage, parseJsonOrThrow, enrichConnectionError, isConnectionError } from '../../../shared/error-message.js';