/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { Tooltip } from '../lib/components/tooltip';

/** Explanatory copy stays available on hover and keyboard focus without
 * consuming a separate settings row. Warnings and current state stay inline. */
export function SettingsHelp({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <Tooltip contentNode={children} delayShow={150} triggerClassName="toolbar-settings-help">
      <button
        type="button"
        class="toolbar-settings-help-button"
        aria-label={`About ${label}`}
        onKeyDown={(event) => {
          // The tooltip owns the first Escape only while it is visible. A
          // subsequent Escape must still dismiss the anchored settings popup.
          if (event.key === 'Escape' && event.currentTarget.getAttribute('aria-describedby')?.includes('pie-tooltip-')) {
            event.stopPropagation();
          }
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 7v4" />
          <circle cx="8" cy="4.8" r=".55" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </Tooltip>
  );
}
