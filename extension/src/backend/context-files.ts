/**
 * Temporary compatibility re-export (repository organization migration B3).
 *
 * The canonical authored context-file assembly moved to
 * `harness/agent-instructions/prompt-assembly/context-files.ts`. This shim
 * keeps the retired `extension/src/backend/` import path working until that
 * root retires (manifest removal owner: B5/B7 batch). Do not add new imports
 * here; import the canonical location instead.
 */
export * from '../../../harness/agent-instructions/prompt-assembly/context-files.js';