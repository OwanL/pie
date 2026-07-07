/** Extension-host entry point for the canonical error helpers.
 *  Re-exports from the root `shared/` package so every package (extension,
 *  analysis, pi extensions) shares one implementation. Existing host call
 *  sites keep importing from '../util/error-message'. */
export { toErrorMessage, parseJsonOrThrow, enrichConnectionError, isConnectionError } from '../../../../shared/error-message.js';