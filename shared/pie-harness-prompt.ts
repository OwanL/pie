/**
 * Temporary compatibility re-export (repository organization migration B3).
 *
 * The canonical Pie-owned system-prompt assembly moved to
 * `harness/agent-instructions/prompt-assembly/pie-harness-prompt.ts`. This
 * shim keeps the retired `shared/` root importable until its retirement batch
 * (manifest removal owner: B8 retired-root removal). Do not add new imports
 * here; import the canonical location instead.
 */
export * from '../harness/agent-instructions/prompt-assembly/pie-harness-prompt.js';