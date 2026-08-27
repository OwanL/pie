/**
 * Transport-neutral renderer interfaces (browser server plan §4.1–§4.2).
 *
 * The host may serve the same UI to several renderer surfaces: the VS Code
 * sidebar and, later, loopback-served browsers. Each surface registers a
 * `RendererTransport` with the `RendererHub`; the hub owns one delivery
 * session per renderer (independent `StateDeliveryController`, readiness
 * probe, commit watchdog, pending imperatives, and visibility belief).
 *
 * The transport interface is a superset of the plan sketch: the readiness
 * probe and commit watchdog need `isAttached`/`isReloading`/`clearReloading`
 * in addition to `post`/`onMessage`/`onVisibilityChanged`/`recover`.
 */

import type {
  HostToWebviewMessage,
  RendererCommandContext,
  RendererKind,
  WebviewToHostMessage,
} from '../../shared/protocol';
import type { StateDeliveryController } from '../sidebar/state-delivery-controller';

/** A renderer target for hub fan-out: a specific `rendererId` or all. */
export type RendererTarget = string | 'all';

export interface DisposableLike {
  dispose(): void;
}

/** One renderer surface as seen by the hub. */
export interface RendererTransport {
  readonly kind: RendererKind;
  /** Deliver one host→renderer message. `false`/rejected means the transport
   *  did not accept it (view gone, socket closed, pre-send gate). */
  post(message: HostToWebviewMessage): boolean | Promise<boolean>;
  /** Subscribe to inbound renderer messages. The handler receives raw
   *  messages; the session validates and routes them. */
  onMessage(handler: (message: unknown) => void): DisposableLike;
  /** Subscribe to renderer visibility transitions. */
  onVisibilityChanged(handler: (visible: boolean) => void): DisposableLike;
  /** Whether the renderer surface is currently attached (view resolved /
   *  socket accepted). */
  isAttached(): boolean;
  /** Whether the transport is mid-reload/reconnect. */
  isReloading(): boolean;
  /** Clear a stale reload/reconnect belief (readiness-probe force-clear). */
  clearReloading(): void;
  /** Trigger a transport-level recovery (webview reload / socket reconnect).
   *  May return a promise that settles when the recovery completes. */
  recover(reason: string): void | Promise<void>;
  dispose(): void;
}

/** Per-renderer delivery debug state (subset of the delivery controller's). */
export interface RendererSessionDebugState {
  visible: boolean;
  /** Browser focus belief (`rendererFocusChanged`); M3 attention arbitration
   *  consumes it. Recorded here so the belief is observable/testable. */
  focused: boolean;
  webviewReady: boolean;
  globalDirty: boolean;
  globalRevision: number;
  lastStateAppliedRevision: number;
  pendingStateAppliedRevision: number | null;
  viewGeneration: number;
  rendererGeneration: number;
  hostInstanceId: string;
}

/** The surface a registered renderer exposes to its adapter. */
export interface RendererRegistration {
  readonly rendererId: string;
  readonly kind: RendererKind;
  getHostInstanceId(): string;
  getViewGeneration(): number;
  getRendererGeneration(): number;
  getDebugState(): RendererSessionDebugState;
  /** One immediate authoritative full snapshot for this renderer. */
  requestState(): void;
  /** Interaction-critical selection snapshot for this renderer. */
  postSelectionState(): void;
  postImperative(message: HostToWebviewMessage): void;
  /** Route one validated inbound message (handshake, evidence, command). */
  handleMessage(message: WebviewToHostMessage): void;
  /** View resolution/replacement: fresh generation, no retained-dirty logic. */
  handleViewResolved(visible: boolean): void;
  /** View disposed / socket closed: clear readiness and invalidate. */
  handleViewDisposed(): void;
  /** Reload/reconnect started by the transport: invalidate delivery. */
  handleReloadStart(reason: string): void;
  /** Visibility transition with retained-dirty resume logic. */
  setVisible(visible: boolean): void;
  /** Focus belief transition (`rendererFocusChanged`). */
  setFocused(focused: boolean): void;
  /** Arm the readiness probe when stuck (adapter calls after attaching). */
  armReadinessProbeIfStuck(): void;
  /** Delivery controller access (readiness-probe path used by adapters/tests). */
  getDeliveryController(): StateDeliveryController<Extract<HostToWebviewMessage, { type: 'state' }>>;
  dispose(): void;
}

/** Host-owned fan-out surface (browser server plan §4.1). */
export interface RendererHub {
  /** Debounced fan-out of one logical render to every renderer session. */
  scheduleState(): void;
  /** Interaction-critical selection fan-out (bounded fast path). */
  scheduleSelectionState(): void;
  /** One immediate authoritative snapshot for a specific renderer. */
  requestState(target: RendererTarget): void;
  /** Whether an ownership tuple still names the live renderer document. */
  isRendererOwnerCurrent(rendererId: string, viewGeneration: number, rendererGeneration: number): boolean;
  /** Targeted or broadcast imperative. */
  postImperative(message: HostToWebviewMessage, target?: RendererTarget): void;
  registerRenderer(transport: RendererTransport): RendererRegistration;
  dispose(): void;
}

export type { RendererCommandContext };
