/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren, JSX } from 'preact';

import { CollapsibleChevron } from './chevron';

import { Tooltip } from './tooltip';

type PanelChipVariant = 'toolbar' | 'pruning';
type PanelChipTone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger' | 'accent';

interface PanelChipBaseProps {
  variant: PanelChipVariant;
  tone?: PanelChipTone;
  label?: ComponentChildren;
  children?: ComponentChildren;
  leading?: ComponentChildren;
  trailing?: ComponentChildren;
  className?: string;
  /**
   * Native tooltip text. Prefer {@link tooltip} for live-updating values where a
   * custom tooltip should survive parent re-renders.
   */
  title?: string;
  /** Custom tooltip text; when present it replaces the native title. */
  tooltip?: string;
  /** Rich tooltip content (JSX). When provided, the tooltip renders this
   *  subtree into the host via an imperative Preact root (instead of setting
   *  textContent), and becomes hoverable. Takes precedence over {@link tooltip}.
   *  See `Tooltip.contentNode`. */
  tooltipNode?: ComponentChildren;
  /**
   * When true, freeze the tooltip text at show time for the duration of the
   * hover (see `Tooltip.freezeWhileVisible`). Use for live-updating indicator
   * tooltips that would otherwise resize/jump on every update.
   */
  freezeWhileVisible?: boolean;
  /** Preferred placement of the custom tooltip relative to the trigger.
   *  Defaults to `'bottom'` to preserve existing behavior outside the toolbar;
   *  toolbar chips override this to `'top'` so the whole model-picker row opens
   *  upward consistently (the default `'bottom'` flips up only on viewport
   *  overflow, which looked inconsistent). */
  placement?: 'top' | 'bottom';
  ariaLabel?: string;
}

interface PanelChipSpanProps extends PanelChipBaseProps {
  as?: 'span' | 'div';
  role?: JSX.AriaRole;
  ariaLive?: 'off' | 'polite' | 'assertive';
  tabIndex?: number;
}

interface PanelChipButtonProps extends PanelChipBaseProps {
  as: 'button';
  expanded?: boolean;
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>;
}

type PanelChipProps = PanelChipSpanProps | PanelChipButtonProps;

function chipClassName({ variant, tone = 'neutral', className }: Pick<PanelChipBaseProps, 'variant' | 'tone' | 'className'>): string {
  return [
    'panel-chip',
    `panel-chip-${variant}`,
    `panel-chip-${tone}`,
    className,
  ].filter(Boolean).join(' ');
}

function chipContent({ label, children, leading, trailing }: Pick<PanelChipBaseProps, 'label' | 'children' | 'leading' | 'trailing'>) {
  return (
    <>
      {leading && <span class="panel-chip-leading" aria-hidden="true">{leading}</span>}
      {label !== undefined ? <span class="panel-chip-label">{label}</span> : children}
      {trailing && <span class="panel-chip-trailing" aria-hidden="true">{trailing}</span>}
    </>
  );
}

function wrapTooltip(node: JSX.Element, tooltip: string | undefined, tooltipNode: ComponentChildren | undefined, freezeWhileVisible?: boolean, placement?: 'top' | 'bottom'): JSX.Element {
  if (tooltipNode !== undefined && tooltipNode !== null && tooltipNode !== '') {
    return <Tooltip contentNode={tooltipNode} freezeWhileVisible={freezeWhileVisible} placement={placement}>{node}</Tooltip>;
  }
  if (!tooltip) return node;
  return <Tooltip content={tooltip} freezeWhileVisible={freezeWhileVisible} placement={placement}>{node}</Tooltip>;
}

export function PanelChip(props: PanelChipProps) {
  const className = chipClassName(props);
  const content = chipContent(props);
  const title = props.tooltip || props.tooltipNode ? undefined : props.title;

  if (props.as === 'button') {
    return wrapTooltip(
      <button
        class={className}
        type="button"
        aria-expanded={props.expanded}
        aria-label={props.ariaLabel}
        title={title}
        onClick={props.onClick}
      >
        {content}
      </button>,
      props.tooltip,
      props.tooltipNode,
      props.freezeWhileVisible,
      props.placement,
    );
  }

  if (props.as === 'div') {
    return wrapTooltip(
      <div
        class={className}
        role={props.role}
        aria-live={props.ariaLive}
        aria-label={props.ariaLabel}
        title={title}
        tabIndex={props.tabIndex}
      >
        {content}
      </div>,
      props.tooltip,
      props.tooltipNode,
      props.freezeWhileVisible,
      props.placement,
    );
  }

  return wrapTooltip(
    <span
      class={className}
      role={props.role}
      aria-live={props.ariaLive}
      aria-label={props.ariaLabel}
      title={title}
      tabIndex={props.tabIndex}
    >
      {content}
    </span>,
    props.tooltip,
    props.tooltipNode,
    props.freezeWhileVisible,
    props.placement,
  );
}

interface ToolbarChipProps {
  label: ComponentChildren;
  title?: string;
  /** Custom tooltip text; when present it replaces the native title. */
  tooltip?: string;
  /** Rich tooltip content (JSX); takes precedence over {@link tooltip}. */
  tooltipNode?: ComponentChildren;
  ariaLabel?: string;
  tone?: PanelChipTone;
  /** Tooltip placement; defaults to `'top'` so toolbar tooltips open upward. */
  placement?: 'top' | 'bottom';
}

export function ToolbarChip({ label, title, tooltip, tooltipNode, ariaLabel, tone = 'muted', placement = 'top' }: ToolbarChipProps) {
  return <PanelChip variant="toolbar" tone={tone} label={label} title={title} tooltip={tooltip} tooltipNode={tooltipNode} ariaLabel={ariaLabel} placement={placement} />;
}

export type ToolbarIndicatorKind = 'tokens' | 'cost' | 'context' | 'speed';

interface ToolbarIndicatorChipProps extends ToolbarChipProps {
  kind: ToolbarIndicatorKind;
  severity?: 'warning' | 'critical' | string | null;
  /** Visual pause marker for indicators whose underlying measurement is frozen (e.g. the speed chip while a tool runs). */
  state?: 'paused' | null;
  /** Freeze the tooltip text at show time for the duration of the hover (for live-updating tooltips). */
  freezeWhileVisible?: boolean;
}

// Indicator chips live on the composer toolbar (the model-picker row), so their
// tooltip defaults to opening upward — consistent with the rest of the row.
function indicatorClassName(kind: ToolbarIndicatorKind, severity?: string | null, state?: 'paused' | null): string {
  return [
    'panel-chip-indicator',
    `panel-chip-indicator-${kind}`,
    kind === 'tokens' && 'session-token-indicator',
    kind === 'cost' && 'session-cost-indicator',
    kind === 'context' && 'context-window-indicator',
    severity,
    state === 'paused' && 'is-paused',
  ].filter(Boolean).join(' ');
}

export function ToolbarIndicatorChip({ kind, severity, state, label, title, tooltip, tooltipNode, ariaLabel, freezeWhileVisible, placement = 'top' }: ToolbarIndicatorChipProps) {
  return (
    <PanelChip
      as="div"
      variant="toolbar"
      tone="neutral"
      className={indicatorClassName(kind, severity, state)}
      role="img"
      tabIndex={0}
      ariaLabel={ariaLabel}
      title={title}
      tooltip={tooltip}
      tooltipNode={tooltipNode}
      freezeWhileVisible={freezeWhileVisible}
      placement={placement}
      label={label}
    />
  );
}

export type ToolbarRunStatusTone = 'open' | 'pending-score' | 'neutral' | string;

function toolbarRunStatusTone(tone: ToolbarRunStatusTone): PanelChipTone {
  if (tone === 'open') return 'success';
  if (tone === 'pending-score') return 'warning';
  return 'muted';
}

interface ToolbarRunStatusChipProps {
  label: ComponentChildren;
  title?: string;
  /** Custom tooltip text; when present it replaces the native title. */
  tooltip?: string;
  tone: ToolbarRunStatusTone;
  /** Tooltip placement; defaults to `'top'` so toolbar tooltips open upward. */
  placement?: 'top' | 'bottom';
}

export function ToolbarRunStatusChip({ label, title, tooltip, tone, placement = 'top' }: ToolbarRunStatusChipProps) {
  return (
    <PanelChip
      as="div"
      variant="toolbar"
      tone={toolbarRunStatusTone(tone)}
      className="panel-chip-run-status"
      role="status"
      ariaLive="polite"
      tabIndex={0}
      title={title}
      tooltip={tooltip}
      placement={placement}
      label={label}
    />
  );
}



interface ToolbarSelectChipProps {
  value: string;
  label: string;
  title: string;
  ariaLabel: string;
  width: 'reasoning';
  onChange: JSX.GenericEventHandler<HTMLSelectElement>;
  children: ComponentChildren;
}

export function ToolbarSelectChip({ value, label, title, ariaLabel, width, onChange, children }: ToolbarSelectChipProps) {
  // Wrap in the custom Tooltip (placement 'top') so the reasoning-level chip's
  // tooltip opens upward like the rest of the model-picker row, instead of the
  // native <select> title whose direction the browser controls.
  return (
    <Tooltip content={title} placement="top">
      <div class={`panel-chip panel-chip-toolbar panel-chip-select panel-chip-${width}-select`}>
        <span class="panel-chip-select-label" aria-hidden="true">{label}</span>
        <CollapsibleChevron open={false} size={10} class="panel-chip-select-caret" />
        <select
          value={value}
          onChange={onChange}
          aria-label={ariaLabel}
        >
          {children}
        </select>
      </div>
    </Tooltip>
  );
}

interface PruningHeaderChipControlProps {
  label: ComponentChildren;
  title: string;
  ariaLabel?: string;
  expanded?: boolean;
  failed?: boolean;
  pending?: boolean;
  leading?: ComponentChildren;
  trailing?: ComponentChildren;
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>;
  onCancel?: () => void;
}

function pruningTone({ failed, expanded }: Pick<PruningHeaderChipControlProps, 'failed' | 'expanded'>): PanelChipTone {
  if (failed) return 'danger';
  if (expanded) return 'accent';
  return 'muted';
}

export function PruningHeaderChipControl(props: PruningHeaderChipControlProps) {
  if (props.pending) {
    return (
      <div class="pruning-header-pending-row flex items-center gap-1.5">
        <PanelChip
          as="div"
          variant="pruning"
          tone="muted"
          className="panel-chip-pruning-pending"
          role="status"
          ariaLive="polite"
          ariaLabel={props.ariaLabel}
          title={props.title}
          label={props.label}
        />
        {props.onCancel && (
          <PanelChip
            as="button"
            variant="pruning"
            tone="warning"
            className="panel-chip-interactive"
            ariaLabel="Cancel pruning prepass"
            title="Cancel the pruning prepass (interrupts this turn)"
            onClick={props.onCancel}
            label="Cancel"
          />
        )}
      </div>
    );
  }

  return (
    <PanelChip
      as="button"
      variant="pruning"
      tone={pruningTone(props)}
      className="panel-chip-interactive"
      expanded={props.expanded}
      ariaLabel={props.ariaLabel}
      title={props.title}
      onClick={props.onClick}
      leading={props.leading}
      label={props.label}
      trailing={props.trailing}
    />
  );
}
