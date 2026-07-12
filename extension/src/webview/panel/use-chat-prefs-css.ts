/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect } from 'preact/hooks';
import type { ChatPrefs, UiDensity } from '../../shared/protocol';
import { ACTIVITY_TAIL_ROW_HEIGHT_PX } from './transcript/activity-tail';
import { accentContrastColor } from './accent-contrast';

/** Gap scale (px) per density. 'comfortable' reproduces the bundled defaults
 *  (xs 4 / sm 6 / md 8 / lg 12 / xl 16) so the default leaves the layout
 *  unchanged. Unknown densities fall back to comfortable in the effect. */
const DENSITY_GAPS: Record<UiDensity, { xs: number; sm: number; md: number; lg: number; xl: number }> = {
  compact: { xs: 3, sm: 5, md: 6, lg: 8, xl: 10 },
  comfortable: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 },
  spacious: { xs: 6, sm: 8, md: 10, lg: 14, xl: 20 },
};

export function useChatPrefsCss(prefs: ChatPrefs) {
  const {
    uiBaseFontSize,
    uiComposerFontSize,
    expandedSectionFontSize,
    expandedSectionMaxHeight,
    activityTailLines,
    subagentPreviewLines,
    uiFontSans,
    uiFontMono,
    uiAccentColor,
    uiMutedColor,
    uiLinkColor,
    uiMessageWidth,
    uiBackground,
    uiForeground,
    uiBorder,
    uiCornerRadius,
    uiDensity,
    uiMessageRailSize,
  } = prefs;

  // Apply UI prefs as CSS custom properties on :root so every component picks
  // them up via var(). Overrides are removed with removeProperty() when they
  // are empty so the bundled stylesheet defaults on :root win; setting an
  // empty string would create an invalid custom-property value and break var()
  // resolution instead of falling back.
  //
  // Color derivations: the background drives the whole --panel-ink ramp
  // (every surface token — cards, inputs, hover, overlays — derives from it via
  // var(), so overriding the ramp cascades automatically). Foreground reuses
  // color-mix toward --panel-ink for the soft/muted shades; border derives its
  // subtle variant by thinning alpha. Radius/density always apply (their
  // defaults reproduce the bundled tokens exactly). Accent keeps its existing
  // hover/contrast derivation.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--expanded-font-size', `${expandedSectionFontSize}px`);
    root.setProperty('--expanded-section-max-height', `${expandedSectionMaxHeight}px`);
    root.setProperty('--activity-tail-content-min-height', `${activityTailLines * ACTIVITY_TAIL_ROW_HEIGHT_PX}px`);
    root.setProperty('--subagent-preview-content-min-height', `${subagentPreviewLines * ACTIVITY_TAIL_ROW_HEIGHT_PX}px`);
    // Per-place font sizes: base body/message text and the composer input.
    root.setProperty('--panel-font-size', `${uiBaseFontSize}px`);
    root.setProperty('--panel-composer-font-size', `${uiComposerFontSize}px`);
    if (uiFontSans) {
      root.setProperty('--panel-font-sans', uiFontSans);
    } else {
      root.removeProperty('--panel-font-sans');
    }
    if (uiFontMono) {
      root.setProperty('--panel-font-mono', uiFontMono);
    } else {
      root.removeProperty('--panel-font-mono');
    }
    root.setProperty('--message-assistant-width', `${uiMessageWidth}%`);
    root.setProperty('--message-assistant-width-narrow', `${Math.min(100, uiMessageWidth + 4)}%`);

    // Background → ink ramp. ink == base; lighter shades mix toward white at
    // small percentages so the default base (#050506) approximates the
    // bundled ramp; black is darkened slightly to preserve the shell layering.
    if (uiBackground) {
      root.setProperty('--panel-black', `color-mix(in srgb, ${uiBackground} 82%, black)`);
      root.setProperty('--panel-ink', uiBackground);
      root.setProperty('--panel-ink-2', `color-mix(in srgb, ${uiBackground} 98%, white)`);
      root.setProperty('--panel-ink-3', `color-mix(in srgb, ${uiBackground} 96%, white)`);
      root.setProperty('--panel-ink-4', `color-mix(in srgb, ${uiBackground} 93%, white)`);
      root.setProperty('--panel-ink-5', `color-mix(in srgb, ${uiBackground} 89%, white)`);
    } else {
      for (const t of ['--panel-black', '--panel-ink', '--panel-ink-2', '--panel-ink-3', '--panel-ink-4', '--panel-ink-5'] as const) {
        root.removeProperty(t);
      }
    }

    // Foreground → foreground + derived soft/muted toward the background.
    if (uiForeground) {
      root.setProperty('--panel-foreground', uiForeground);
      root.setProperty('--panel-foreground-soft', `color-mix(in srgb, ${uiForeground} 90%, var(--panel-ink))`);
      root.setProperty('--panel-muted', `color-mix(in srgb, ${uiForeground} 60%, var(--panel-ink))`);
    } else {
      root.removeProperty('--panel-foreground');
      root.removeProperty('--panel-foreground-soft');
      root.removeProperty('--panel-muted');
    }

    // Muted text override — takes precedence over the foreground-derived shade
    // when set, so secondary-text contrast can be tuned independently. Empty
    // restores the derived value (or the bundled default when foreground is
    // also empty).
    if (uiMutedColor) {
      root.setProperty('--panel-muted', uiMutedColor);
    }

    // Border → border + derived subtle (thinned alpha, ~0.58× to match the
    // bundled subtle/border ratio). Empty restores the bundled cream lines.
    if (uiBorder) {
      root.setProperty('--panel-border', uiBorder);
      root.setProperty('--panel-border-subtle', `color-mix(in srgb, ${uiBorder} 58%, transparent)`);
    } else {
      root.removeProperty('--panel-border');
      root.removeProperty('--panel-border-subtle');
    }

    // Accent → accent + hover shade + readable foreground.
    if (uiAccentColor) {
      root.setProperty('--panel-accent', uiAccentColor);
      root.setProperty('--panel-accent-strong', 'color-mix(in srgb, var(--panel-accent) 82%, white)');
      const contrast = accentContrastColor(uiAccentColor);
      if (contrast) {
        root.setProperty('--panel-accent-contrast', contrast);
      } else {
        root.removeProperty('--panel-accent-contrast');
      }
    } else {
      root.removeProperty('--panel-accent');
      root.removeProperty('--panel-accent-strong');
      root.removeProperty('--panel-accent-contrast');
    }

    // Link color override — sets --panel-link directly. Empty removes the
    // override so links fall back to --panel-accent (the bundled default).
    if (uiLinkColor) {
      root.setProperty('--panel-link', uiLinkColor);
    } else {
      root.removeProperty('--panel-link');
    }

    // Corner radius → sm/md/lg/xl as r-2/r/r+2/r+4 (default 8 = 6/8/10/12).
    root.setProperty('--panel-radius-sm', `${Math.max(0, uiCornerRadius - 2)}px`);
    root.setProperty('--panel-radius-md', `${uiCornerRadius}px`);
    root.setProperty('--panel-radius-lg', `${uiCornerRadius + 2}px`);
    root.setProperty('--panel-radius-xl', `${uiCornerRadius + 4}px`);

    // Density → gap scale. 'comfortable' reproduces the bundled defaults.
    const gaps = DENSITY_GAPS[uiDensity] ?? DENSITY_GAPS.comfortable;
    root.setProperty('--panel-gap-xs', `${gaps.xs}px`);
    root.setProperty('--panel-gap-sm', `${gaps.sm}px`);
    root.setProperty('--panel-gap-md', `${gaps.md}px`);
    root.setProperty('--panel-gap-lg', `${gaps.lg}px`);
    root.setProperty('--panel-gap-xl', `${gaps.xl}px`);

    // Message-rail marker size. The hit-area height is applied inline per marker
    // (see MessageRail); this var drives the visible dot so it scales with the
    // click target. The dot is clamped so it never exceeds the 10px rail width
    // on hover.
    root.setProperty('--message-rail-marker-size', `${uiMessageRailSize}px`);
  }, [
    uiBaseFontSize,
    uiComposerFontSize,
    expandedSectionFontSize,
    expandedSectionMaxHeight,
    activityTailLines,
    subagentPreviewLines,
    uiFontSans,
    uiFontMono,
    uiAccentColor,
    uiMutedColor,
    uiLinkColor,
    uiMessageWidth,
    uiBackground,
    uiForeground,
    uiBorder,
    uiCornerRadius,
    uiDensity,
    uiMessageRailSize,
  ]);
}
