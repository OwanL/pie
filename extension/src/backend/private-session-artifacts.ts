import * as fs from 'node:fs/promises';

import { forgetSessionReviewSidecars, resolveSessionIdentity } from './session-review-store';
import { writeSystemPromptTogglesForSession } from './system-prompt-toggle-store';

export interface ForgetPrivateSessionArtifactsDeps {
  forgetReviewSidecars?: typeof forgetSessionReviewSidecars;
  clearSystemPromptToggles?: (sessionPath: string) => Promise<void>;
  deleteTranscript?: (sessionPath: string) => Promise<void>;
}

/** Remove fallible sidecars before committing transcript deletion. Once the
 * transcript removal resolves, no fallible cleanup remains in this operation. */
export async function forgetPrivateSessionArtifacts(
  sessionPath: string,
  deps: ForgetPrivateSessionArtifactsDeps = {},
): Promise<void> {
  const sessionId = (() => {
    try { return resolveSessionIdentity(sessionPath).sessionId; } catch { return undefined; }
  })();
  (deps.forgetReviewSidecars ?? forgetSessionReviewSidecars)(sessionPath, sessionId);
  await (deps.clearSystemPromptToggles
    ?? ((path) => writeSystemPromptTogglesForSession(path, [], true)))(sessionPath);
  await (deps.deleteTranscript ?? ((path) => fs.rm(path, { force: true })))(sessionPath);
}
