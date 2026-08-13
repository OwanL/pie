import * as crypto from 'node:crypto';

import type {
  FunctionalSettingsSnapshot,
  SessionAnalyticsFactors,
} from '../../../../shared/run-analytics-contracts.js';

/**
 * Derive the deterministic, privacy-safe harness fingerprint stamped on new
 * runs. The fingerprint is the SHA-256 digest of a canonical serialization of
 * the harness revision plus the analytics factors and functional settings
 * captured at run start, so identical setups always produce the identical
 * fingerprint while any factor change flips it. The run snapshot already
 * stores the captured factors/settings themselves; this function introduces no
 * additional raw treatment data and persists only the derived digest.
 *
 * Canonicalization rules:
 * - Multi-value fields are sorted before serialization so unordered captures
 *   hash identically.
 * - `promptCapturedAt` and skill `lastModifiedAt` are intentionally excluded:
 *   they are capture metadata (timestamps), not treatment factors — a no-op
 *   save or re-capture must not flip the fingerprint. This mirrors the mtime
 *   redaction used for skill treatment comparison in run-state-manager.
 */
export function deriveHarnessFingerprint(
  revision: string,
  factors: SessionAnalyticsFactors | null,
  functionalSettings: FunctionalSettingsSnapshot | null,
): string {
  const canonical = JSON.stringify({
    revision,
    factors: factors === null
      ? null
      : {
          promptFamily: factors.promptFamily,
          promptHash: factors.promptHash,
          harnessPromptHash: factors.harnessPromptHash,
          customPromptHash: factors.customPromptHash,
          appendSystemPromptHash: factors.appendSystemPromptHash,
          promptGuidelineHashes: [...factors.promptGuidelineHashes].sort(),
          contextFiles: [...factors.contextFiles]
            .map((file) => ({ path: file.path, hash: file.hash }))
            .sort((a, b) => a.path.localeCompare(b.path)),
          selectedToolIds: [...factors.selectedToolIds].sort(),
          toolSnippetHashes: [...factors.toolSnippetHashes]
            .map((snippet) => ({ toolId: snippet.toolId, hash: snippet.hash }))
            .sort((a, b) => a.toolId.localeCompare(b.toolId)),
          toolSetHash: factors.toolSetHash,
          skills: [...factors.skills]
            .map((skill) => ({
              name: skill.name,
              contentHash: skill.contentHash,
              sourceHash: skill.sourceHash,
              disableModelInvocation: skill.disableModelInvocation,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          skillSetHash: factors.skillSetHash,
          activeExtensions: [...factors.activeExtensions].sort(),
        },
    functionalSettings: functionalSettings === null
      ? null
      : {
          subagentAlwaysParentModel: functionalSettings.subagentAlwaysParentModel,
          pruningMode: functionalSettings.pruningMode,
          extensionToggles: Object.fromEntries(
            Object.entries(functionalSettings.extensionToggles).sort(([a], [b]) => a.localeCompare(b)),
          ),
          toolResultPruningEnabled: functionalSettings.toolResultPruningEnabled,
          toolResultPruningProfile: functionalSettings.toolResultPruningProfile,
        },
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
