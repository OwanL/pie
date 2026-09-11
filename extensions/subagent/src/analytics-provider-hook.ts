import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { readRuntimeContext } from '../runner.js';
import {
  captureSubagentProviderDispatch,
  readSubagentAnalyticsAttemptState,
} from './analytics-capture.js';

/** Register the pinned SDK's per-provider-request observation seam. This
 * lightweight module intentionally has no renderer or SDK runtime imports so
 * the handler can be qualified in isolation. */
export function registerSubagentAnalyticsProviderHook(
  pi: Pick<ExtensionAPI, 'on' | 'getThinkingLevel'>,
): void {
  pi.on('before_provider_request', (_event, context) => {
    const runtimeContext = readRuntimeContext();
    const attemptState = readSubagentAnalyticsAttemptState(runtimeContext);
    if (!runtimeContext.analyticsCapture || !attemptState) return;
    try {
      captureSubagentProviderDispatch(runtimeContext.analyticsCapture, attemptState, {
        provider: context.model?.provider,
        model: context.model?.id,
        thinkingLevel: pi.getThinkingLevel(),
        observedAtMs: Date.now(),
      });
    } catch {
      // Analytics never gates a provider request. Preserve a visible rejected
      // receipt without retaining a potentially sensitive thrown message.
      attemptState.factStatus = 'rejected';
      attemptState.error = 'Subagent provider dispatch capture failed.';
    }
  });
}
