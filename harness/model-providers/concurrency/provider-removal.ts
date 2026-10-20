import { isProviderRemoved } from '../runtime/selector-policy.js';

/** Admission denial is not evidence of provider transport failure. */
export class ProviderRemovedError extends Error {
  readonly isRetryable = false;
  readonly httpStatus = 403;
  constructor(provider: string) {
    super(`Provider "${provider}" has been removed.`);
    this.name = 'ProviderRemovedError';
  }
}

export function assertProviderAdmission(provider: string): void {
  if (isProviderRemoved(provider)) throw new ProviderRemovedError(provider);
}

/** Reuse queue deadline timers to observe live removal without a config watcher. */
export const PROVIDER_REMOVAL_POLL_MS = 250;
