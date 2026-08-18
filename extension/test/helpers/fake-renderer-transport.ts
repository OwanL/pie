/**
 * Deterministic fake `RendererTransport` for renderer-hub tests (browser
 * server plan Milestone 0: "Build fake host and client transports for
 * deterministic tests").
 */

import type { HostToWebviewMessage, RendererKind, WebviewToHostMessage } from '../../src/shared/protocol';
import type { DisposableLike, RendererTransport } from '../../src/host/renderers/types';

export class FakeRendererTransport implements RendererTransport {
  readonly kind: RendererKind;
  readonly posted: HostToWebviewMessage[] = [];
  attached = true;
  reloading = false;
  recoverCalls: string[] = [];
  /** Per-post outcomes; `true` when exhausted. */
  postOutcomes: Array<boolean | Promise<boolean>> = [];
  private messageHandler?: (message: unknown) => void;
  private visibilityHandler?: (visible: boolean) => void;

  constructor(kind: RendererKind = 'vscode') {
    this.kind = kind;
  }

  post(message: HostToWebviewMessage): boolean | Promise<boolean> {
    this.posted.push(message);
    return this.postOutcomes.shift() ?? true;
  }

  onMessage(handler: (message: unknown) => void): DisposableLike {
    this.messageHandler = handler;
    return {
      dispose: () => {
        if (this.messageHandler === handler) this.messageHandler = undefined;
      },
    };
  }

  onVisibilityChanged(handler: (visible: boolean) => void): DisposableLike {
    this.visibilityHandler = handler;
    return {
      dispose: () => {
        if (this.visibilityHandler === handler) this.visibilityHandler = undefined;
      },
    };
  }

  isAttached(): boolean {
    return this.attached;
  }

  isReloading(): boolean {
    return this.reloading;
  }

  clearReloading(): void {
    this.reloading = false;
  }

  recover(reason: string): void {
    this.recoverCalls.push(reason);
  }

  dispose(): void {
    this.attached = false;
  }

  /** Test helper: inject one inbound renderer message. */
  send(message: WebviewToHostMessage): void {
    this.messageHandler?.(message);
  }

  /** Test helper: simulate a visibility transition. */
  setVisible(visible: boolean): void {
    this.visibilityHandler?.(visible);
  }

  stateMessages(): Array<Extract<HostToWebviewMessage, { type: 'state' }>> {
    return this.posted.filter((message): message is Extract<HostToWebviewMessage, { type: 'state' }> => message.type === 'state');
  }
}
