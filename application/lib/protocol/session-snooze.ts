export type SessionSnoozeDuration = 4 | 8 | 12 | 24 | 48 | 'monday';

export interface SnoozedSession {
  path: string;
  name: string;
  /** Host-derived epoch milliseconds. */
  wakeAt: number;
}

export function sessionSnoozeWakeAt(now: number, duration: SessionSnoozeDuration): number {
  if (duration !== 'monday') return now + duration * 60 * 60 * 1000;
  const date = new Date(now);
  const days = (8 - date.getDay()) % 7;
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 7);
  return date.getTime();
}
