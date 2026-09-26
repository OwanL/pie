export interface SessionCompletionEvent {
  sessionPath: string;
}

export interface CompletionNotificationPolicy {
  suppressNotifications: boolean;
  windowFocused: boolean;
}

export interface CompletionTabAttentionPolicy {
  suppressNotifications: boolean;
  sessionIsActive: boolean;
}

export function shouldShowCompletionNotification(policy: CompletionNotificationPolicy): boolean {
  if (policy.suppressNotifications) {
    return false;
  }

  return !policy.windowFocused;
}

export function shouldFlashFinishedTab(policy: CompletionTabAttentionPolicy): boolean {
  if (policy.suppressNotifications) {
    return false;
  }

  return !policy.sessionIsActive;
}
