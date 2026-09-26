import type { JSX } from 'preact';

/**
 * Adapt a Preact JSX context-menu event to the DOM `MouseEvent` shape that
 * transcript context-menu handlers expect.
 *
 * Preact's `TargetedMouseEvent` already wraps a native `MouseEvent` at runtime;
 * the only mismatch is the typed `currentTarget`. This helper centralizes the
 * cast so call sites stay type-safe.
 */
export function toMouseEvent<T extends HTMLElement>(e: JSX.TargetedMouseEvent<T>): MouseEvent {
  return e as unknown as MouseEvent;
}
