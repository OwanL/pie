# Pie Browser Server Implementation Plan

**Status:** proposed; not started
**Initial deployment:** the existing VS Code extension host on the user's PC
**Initial network boundary:** loopback only (`127.0.0.1`)
**Later deployment:** authenticated HTTPS ingress to the same loopback service

## 1. Goal

Serve Pie's existing Preact UI in an ordinary browser while retaining the current host and backend as the only application and execution authorities.

When VS Code opens and Pie activates:

1. Pie starts its existing backend and host state machine.
2. Pie starts an embedded HTTP/WebSocket server on `127.0.0.1`, preferring port `1997` for the first active VS Code window and selecting a separate loopback port for another window when needed.
3. The server's actual loopback URL serves the same compiled UI bundle used by the sidebar; Pie's browser commands always use that instance-specific URL.
4. The browser registers as another passive renderer of the existing host state.
5. Closing/reloading the extension stops the listener and all browser connections.

The first release is local-only. A later phase puts the loopback service behind authenticated HTTPS ingress, such as Cloudflare Tunnel + Access, without exposing a public listener from Pie itself.

## 2. Product contract

### 2.1 Required first-release experience

- The browser renders the same components, styles, session tabs, transcript, composer, model controls, tool calls, extension-UI prompts, notices, and settings surfaces as the VS Code sidebar.
- There is one UI implementation and one webview build. Browser mode is a transport/bootstrap mode, not a fork of the UI.
- The sidebar and browser may be open simultaneously.
- Both surfaces observe the same host-owned active session, tabs, transcript, settings, pending operations, and backend lifecycle. Selecting a session in either surface selects it in both.
- Scroll, focus, caret, hover, open menus, and other allowlisted renderer-local state remain independent per surface.
- A slow, hidden, disconnected, or broken browser must not delay sidebar rendering or agent execution, and vice versa.
- Refreshing or reconnecting the browser recovers from a full snapshot and never starts a second backend or replays a tool.
- The local server starts automatically with Pie, requires no setup, and binds only to loopback.
- Commands provide discoverability:
  - `pie: Open in Browser`
  - `pie: Copy Browser URL`
  - `pie: Restart Browser Server`
- Only a terminal bind/start failure produces one clear Pie notice and log entry; a successful fallback is an informational log with no notice. Neither outcome may prevent the sidebar or backend from working.

### 2.2 Initial browser behavior for VS Code-owned actions

The browser is initially a second view of the VS Code-hosted Pie instance, not a web IDE. Existing host-side actions retain these semantics until web-native viewers are implemented:

| Action | Initial browser behavior |
|---|---|
| Send, edit, interrupt, session/model/settings actions | Full support through the existing host/reducer/effect path |
| Model-switch confirm modal | Milestone 2 source-aware confirmation seam. The VS Code `ShowModelSwitchConfirm` modal (`ModalSink.showWarningModal` in `host/core/effect-runner.ts`) is invisible to a browser; browser-initiated switches use a host-owned inline confirmation imperative rendered in the initiating renderer, and the host proceeds only on that renderer's explicit confirm |
| Destructive file actions (`revertFile` via `FileRevert` → `fileDiffService.revertFile`) | Milestone 2 source-aware, host-owned inline confirmation in the initiating renderer; never an invisible desktop modal |
| Tool and extension-UI interactions | Full support through the existing host path |
| Open file / open diff / reveal file | Execute in the host VS Code window and return a targeted `rendererNotice` to the initiating browser |
| Attachments | Browser image paste/drop uses a bounded `addComposerInput` transfer. The browser retains image bytes in page memory until the host accepts the transfer and a confirming snapshot shows the host-owned input metadata/identity; the host then owns the bounded bytes in `pendingComposerInputs`, and a later `send` consumes host state. No image bytes enter `sessionStorage`; sending from another renderer is allowed only after host confirmation. An unconfirmed transfer lost on close/reload is reconciled by the §5.2 precedence — the host command-decision ledger is queried first, and snapshot absence alone never proves rejection — and asks the user to reattach only when neither the ledger nor the snapshot confirms acceptance and page memory is gone. Arbitrary browser `File` attachments have no host filesystem path and are deferred to Milestone 4 |
| Clipboard | Use browser clipboard APIs and existing fallbacks |
| Completion attention | At most one visible eligible renderer receives completion attention, chosen by the deterministic host-owned arbitration in §8.3; all hidden means no renderer sound/UI recipient. Desktop window flashing (`requestWindowAttention` in `host/sidebar/completion-notification.ts`) is a separate current-host policy |
| Logs and exported files | Existing host behavior initially; browser-native download/viewing is a later capability |

Milestone 2 includes the minimum source-aware confirmation seam for model switches and destructive reverts. A later milestone adds browser-native read-only file and diff viewers, exports, and attachment selection; those enhancements are not prerequisites for proving the browser transport. The rows above are the MVP contract.

### 2.3 Explicit non-goals for the local MVP

- Running Pie after VS Code is closed.
- Moving the host state machine or backend into the browser.
- Exposing backend JSON-RPC, arbitrary filesystem HTTP endpoints, or generic command execution to the browser.
- Independent active-session selection or independent host-owned composer state per renderer.
- LAN binding, `0.0.0.0`, router port forwarding, TLS, or public internet exposure.
- Reimplementing the UI, changing its visual language, or introducing a second frontend build.
- Full browser-based source editing.

## 3. Existing architecture and reusable seams

| Concern | Current owner | Reuse/change |
|---|---|---|
| Application authority | `extension/src/host/core/*` and `ArchState` | Reuse unchanged; browser commands still enter the reducer/effect path |
| Backend execution | `extension/src/backend/*` via `host/backend/client.ts` | Reuse unchanged; never connect the browser directly |
| Projection | `host/core/projection.ts` | Reuse; one shared logical `ViewState` |
| Snapshot delivery | `host/sidebar/state-delivery-controller.ts` | Reuse one independent instance per renderer; share one expensive projected/JSON-safe state body per logical render, then assemble each renderer's delivery envelope (§4.1) |
| Readiness/recovery | `readiness-probe.ts`, `state-applied-watchdog.ts` | Reuse policies with renderer-specific recovery adapters |
| VS Code renderer | `host/sidebar/provider.ts` | Refactor into a VS Code adapter registered with a renderer hub |
| Shared protocol | `shared/protocol/webview.ts` | Extend for renderer identity/visibility, command acknowledgement, and browser ingress bounds; bump `WEBVIEW_PROTOCOL_VERSION` in `shared/protocol/core.ts` |
| UI entry | `webview/panel/panel.tsx` | Extract a transport bootstrap; retain one Preact application |
| UI adapter | `webview/panel/app.tsx` | Extend `AppAdapter` with inbound subscription/lifecycle methods |
| Webview assets | `host/webview/assets.ts`, Vite manifest | Split generic manifest/HTML work from VS Code URI/CSP resolution |
| Build output | `out/webview/panel/` | Serve the same hashed entry, CSS, chunks, and manifest over HTTP |

The implementation must preserve the CQRS/Elm-style MVI contract: browser messages are renderer intents, not a second state authority.

## 4. Target architecture

```text
                                      ┌────────────────────────────┐
                                      │ PI backend child process   │
                                      │ SDK, tools, sessions       │
                                      └──────────────▲─────────────┘
                                                     │ JSON-RPC/stdio
                                                     │
┌──────────────────────── VS Code extension host ────┴──────────────────────┐
│                                                                          │
│  Webview/WS command ─► RendererHub ─► MessageRouter ─► reducer/effects   │
│                              ▲                         │                  │
│                              │                         ▼                  │
│                       projected ViewState ◄────── ArchState              │
│                              │                                            │
│             ┌────────────────┴────────────────┐                           │
│             │                                 │                           │
│    VS Code renderer session          Browser renderer session            │
│    postMessage + view lifecycle      WebSocket + page lifecycle          │
│    independent delivery ledger       independent delivery ledger         │
│             │                                 │                           │
└─────────────┼─────────────────────────────────┼───────────────────────────┘
              ▼                                 ▼
      VS Code Pie sidebar              HTTP-served Pie Preact UI
                                      http://127.0.0.1:<instance-port>
```

### 4.1 Renderer hub

Introduce a host-owned `RendererHub` between `PieExtension` and renderer transports. It owns a registry of renderer sessions. Each renderer session owns:

- an unguessable in-process `rendererId`;
- renderer kind (`vscode` or `browser`);
- a connection/reload generation;
- its own `SidebarSyncState` or replacement delivery-sync state;
- its own `StateDeliveryController`;
- readiness and visibility beliefs;
- readiness probe, commit watchdog, and recovery state;
- pending targeted imperatives;
- disposal and telemetry metadata.

The hub provides the host-facing surface currently supplied by `SidebarViewProvider`:

```ts
interface RendererHub {
  scheduleState(): void;
  scheduleSelectionState(): void;
  requestState(target: RendererTarget): void;
  postImperative(message: HostToWebviewMessage, target?: RendererTarget): void;
  registerRenderer(transport: RendererTransport): RendererRegistration;
  dispose(): void;
}
```

The existing `ready`, `refreshState`, and `requestSnapshot` callbacks call `requestState()` for their source renderer only. Selection changes still mutate shared host state and fan out to all renderers, while `scheduleSelectionState()` preserves the current bounded fast path for the initiating interaction. VS Code-only reveal/focus behavior remains on the sidebar adapter rather than being generalized into the hub.

`PieExtension.scheduleRender()` fans one projection change out to every renderer session. Each session builds and delivers its own renderer envelope at its own pace. No post/commit gate is shared across renderers.

**Host event-loop isolation.** Per-renderer delivery controllers isolate *delivery state*, but projection/normalization, envelope assembly, and `ws.send` still execute on the extension host event loop. The MVP therefore adds three host-side rules:

- **One shared state body, distinct renderer envelopes per logical render.** `selectViewState`/`projectViewState` (`host/core/projection.ts`) runs once per logical render, and the hub performs JSON-safe normalization once. The normalized `ViewState` body may also be encoded once into immutable JSON bytes shared by the browser transports; that shared body excludes delivery metadata. The host-side browser wire encoder treats those bytes as a validated JSON object fragment and emits `envelope-prefix + shared-body + envelope-suffix`, so every browser envelope adds its own `hostInstanceId`, `rendererId`, `rendererGeneration`, `revision`, and body metadata through a bounded small envelope assembly/serialization. Thus N browser sockets have N small, renderer-specific envelope assemblies/serializations and N transport sends; the plan does **not** claim one complete serialized envelope for all renderers. VS Code receives an object envelope and `webview.postMessage` uses structured clone rather than JSON wire serialization.
- **Pre-send gates.** Before a browser `ws.send`, the host-side renderer transport measures the complete candidate frame (`frameBytes`, including its renderer envelope) and rejects/coalesces it when `bufferedAmount > 8 MiB` or `bufferedAmount + frameBytes > 32 MiB`; it also enforces the browser client count (max 4 concurrent browser renderers per host instance) and the existing bounded snapshot producer budget (never above 30 MiB before the 32 MiB hard record ceiling). A single frame may therefore be large but bounded; a lagging browser receives the **latest** snapshot only — delivery is latest-wins coalescing, never a backlog queue.
- **No browser work on the reducer/effect/backend path.** Browser ingress handling is synchronous, bounded, and fail-closed (§5.3); `ws.send` never awaits browser backpressure; reducer/effect dispatch and backend RPC are host-owned and independent of every renderer's delivery state.

Worker threads are **not** proposed for the MVP: the shared projection/normalization/body encoding and each bounded envelope assembly remain within the snapshot budget. The measurable event-loop budget is a 10 ms ticker with no delivery turn delayed by more than 100 ms and a target p95 delay of at most 50 ms while max-budget data is framed and sent on supported hardware. Revisit worker isolation only if the §12.1 large-snapshot latency test exceeds that budget.

### 4.2 Renderer transport

Define a transport-neutral host interface:

```ts
interface RendererTransport {
  readonly kind: 'vscode' | 'browser';
  post(message: HostToWebviewMessage): Promise<boolean>;
  onMessage(handler: (message: unknown) => void): Disposable;
  onVisibilityChanged(handler: (visible: boolean) => void): Disposable;
  recover(reason: string): void;
  dispose(): void;
}
```

- The VS Code adapter wraps `WebviewView.webview.postMessage`, `onDidReceiveMessage`, visibility, and HTML reload.
- The browser adapter wraps one authenticated/accepted WebSocket, browser visibility messages, socket close, and reconnect-by-new-registration.
- A WebSocket send callback proves only transport settlement. Existing renderer evidence remains the proof of receipt, app commit, transcript correctness, and paint.

### 4.3 Browser-side transport

Replace the hard-coded `acquireVsCodeApi()` bootstrap with a browser-side interface:

```ts
interface ClientTransport {
  postMessage(message: WebviewToHostMessage): void;
  subscribe(handler: (message: HostToWebviewMessage) => void): () => void;
  getConnectionState(): 'connecting' | 'connected' | 'disconnected';
  dispose(): void;
}
```

Implement:

- `VsCodeClientTransport`: `acquireVsCodeApi().postMessage` plus `window.message`.
- `BrowserClientTransport`: same-origin WebSocket plus bounded JSON serialization for outbound commands, reconnection, and connection status. It parses host-emitted renderer-specific envelopes; the host-side browser renderer transport performs the shared-body framing and per-renderer envelope assembly in §4.1. The client never sends a command when disconnected and applies latest-wins behavior to inbound snapshots; host-side pre-send gates drop/coalesce when the socket is above the 8 MiB high-water mark or the combined candidate would exceed the 32 MiB record limit.

`AppAdapter` receives both outbound posting and inbound subscription. `use-host-sync.ts` stops registering `window.message` directly and subscribes through the adapter instead. All components beneath that seam remain shared.

Browser mode is selected by server-injected bootstrap metadata, not by a separate bundle. The HTTP HTML stamps only stable page data: asset version, transport kind, and WebSocket route. VS Code HTML continues to stamp its existing generation metadata.

A browser renderer's identity cannot be fixed in HTML because a WebSocket reconnect creates a new registration without reloading the page. On every accepted socket, the server first sends a typed `rendererHello` containing `hostInstanceId`, `rendererId`, `rendererGeneration`, protocol version, and asset version. `BrowserClientTransport` replaces its in-memory identity from that hello before sending `ready`; all later commands/evidence use that current socket identity. The host still treats the socket registration—not echoed JSON fields—as the trusted source. A reconnect therefore cannot retain a stale DOM generation.

### 4.4 Multi-renderer state semantics

The local MVP deliberately keeps host logic state shared:

- `activeSessionPath`, tabs, settings, editing, `pendingComposerInputs` (including accepted bounded image bytes), notices, and extension-UI ownership remain in host-owned `ArchState`. Browser page memory is only the pre-acceptance staging area; a later `send` consumes the host-owned pending inputs, and the host snapshot projects their metadata/identity to every renderer.
- A host-state change caused by any renderer is projected to all renderers.
- Renderer-local ephemeral state remains local under the existing `STATE_CONTRACT.md` allowlist.
- Simultaneous edits follow the existing host command ordering; no collaborative-editing model is added.
- Interactive extension-UI requests may be answered by either connected renderer; the first valid response settles the host-owned request and the next snapshot removes it everywhere.

Target only imperatives whose correctness depends on the initiating renderer:

- `sendRejected` draft/optimistic-overlay restoration;
- lazy-detail responses;
- `rendererNotice` feedback for a capability executed outside the browser;
- renderer recovery/reload instructions;
- future browser-only capability responses.

Global notices and authoritative state remain snapshot-driven. Completion attention is arbitrated host-side: at most **one visible eligible** renderer receives the completion attention imperative per completion, chosen by the deterministic priority in §8.3, independent of VS Code window focus. If all renderers are hidden, no renderer receives sound/UI attention; an optional desktop OS flash is a separate current-host policy. `requestWindowAttention` fires only when the visible sidebar is the chosen renderer. See §8.3 for the arbitration contract and tests.

## 5. Protocol changes

Update `docs/STATE_CONTRACT.md` and the sync-contract tests in the same implementation change. The contract must explicitly distinguish shared host identity from per-renderer delivery identity.

### 5.1 Identity and evidence

Bump `WEBVIEW_PROTOCOL_VERSION` in `shared/protocol/core.ts` (currently 4; `PROTOCOL_VERSION` is 14). Every state envelope/evidence exchange must include or be bound to:

- `hostInstanceId`: shared extension-host incarnation;
- `rendererId`: host-assigned renderer session, never trusted from an unauthenticated payload;
- `rendererGeneration`: reload/reconnect fence for that renderer;
- `revision`: contiguous delivery revision scoped to that renderer;
- existing expected transcript identity and snapshot byte metadata.

Inbound evidence is routed by the transport registration first, then checked against that renderer's accepted ledger. Evidence from renderer A can never settle renderer B even when their numeric revisions match.

The current contract statement that envelope revisions are global must become per-renderer. Full snapshots make cross-renderer revision comparison unnecessary; `hostInstanceId` still detects host replacement.

### 5.2 Source context and targeted responses

The transport supplies trusted source context when routing a validated message:

```ts
interface RendererCommandContext {
  rendererId: string;
  kind: 'vscode' | 'browser';
  rendererGeneration: number;
}
```

Do not accept source identity from browser JSON. Carry the context only as far as required for targeted imperatives. Prefer existing request/correlation IDs plus a bounded host map over adding renderer identity to durable session/backend data.

**Command acknowledgement and reconnect uncertainty.** Every application command envelope from a browser carries a browser-minted `clientCommandId` (UUID, unique per renderer generation). For each schema-valid command that reaches host command routing, the host records exactly one terminal decision and performs exactly one host-side `commandAck` emission for that command:

- `accepted` — the command passed fail-closed ingress validation (§5.3) and entered the reducer/effect path;
- `rejected` — command-level validation or routing failed, with a typed reason.

The exactly-once property is about the host decision and emission, not network delivery. A close can occur after the host emits the ack but before the browser observes it, so the client may observe one ack (`accepted` or `rejected`) or zero acks and then mark the command `unknown`. A schema-invalid message is not a validated application command: it is rejected before routing under §5.3 and does not receive an application ack. A duplicate `clientCommandId` is not run twice. The bounded host decision ledger stores a canonical command fingerprint with the decision: a same-fingerprint duplicate is answered only through a status response, while a different-payload reuse is a typed protocol violation that receives no second `commandAck` and closes the socket; neither path re-enters the reducer/effect path.

The browser keeps a bounded pending-command store (in-memory, last 32 entries, mirrored to `sessionStorage` at ≤ 64 KiB for page reload) holding every sent-but-unacknowledged command plus its bounded optimistic UI metadata. For `addComposerInput`, the live page-memory staging copy is retained until an accepted host ack and a confirming snapshot; the mirror contains only bounded metadata/fingerprint and never image bytes, base64, data URLs, `Blob`s, or `ArrayBuffer`s. Once accepted, the bounded image bytes belong to host-owned `pendingComposerInputs`; later `send` consumes that host state rather than asking a renderer to resend the image. On socket reconnect or page reload:

- **never replay** an accepted or unknown mutating command automatically — the host may already have applied it;
- pending commands whose ack was lost become **unknown**: the UI shows a time-bounded uncertain state (≤ 10 s or until the next authoritative snapshot reflects the effect, whichever is first);
- the browser reconnects, requests a full snapshot, and sends bounded read-only `commandStatusRequest`s for unknown IDs. The host consults a bounded, host-instance-local decision ledger (command ID, canonical fingerprint, and decision only, with a finite TTL) and returns the retained `accepted`/`rejected` decision or `unknown`; it never executes the command as part of reconciliation;
- for an `addComposerInput` with an unobserved ack, reconciliation follows this precedence: the browser first queries the bounded host command-decision ledger for the command ID; an `accepted` decision is authoritative even when the pending input is absent from the snapshot — the input may already have been consumed by a `send` or removed by another authoritative host action — so the browser follows the current snapshot/transcript and shows no reattach prompt; a `rejected` decision means the transfer was not accepted, so the browser restores the input from page memory or asks the user to reattach when page memory is gone; a `notFound`/`expired` ledger answer combined with a snapshot that confirms the input's absence means the transfer was never accepted, so the browser restores from page memory or asks to reattach. Snapshot presence of the matching session/input metadata and identity can confirm acceptance early, but snapshot absence alone never proves rejection. The browser never replays the image payload. A renderer may send using an image only after it has observed that host confirmation;
- an authoritative snapshot may promote other `unknown` commands only when a typed command-specific status/effect marker confirms the outcome. Otherwise the command remains `unknown`, while its optimistic overlay is merged or removed according to the authoritative snapshot. This is status reconciliation, not a promise of exactly one observed ack.

Draft restoration is snapshot-authoritative: `sendRejected` remains a targeted imperative for the live socket, but after reconnect the browser restores its draft from the host-owned composer state in the authoritative snapshot reconciled with its local draft — never from a stale targeted imperative. Deterministic tests cover host-received-before-close (command applied, exactly one host ack emission, zero observed acks; the reconnect status/snapshot confirms it, no replay, UI resolves), ack-observed accepted/rejected, never-received (socket closed before the host processed the command; no replay, status remains or resolves to unknown, draft preserved), and cross-renderer-consumed-before-reconnect (a second renderer's `send` consumes the host-owned pending input before the first renderer reconnects; the first renderer's ledger query returns `accepted` even though the snapshot no longer shows the input, and the UI follows the snapshot with no reattach prompt).

**Targeted responses.** Map `sendRejected` and `rendererNotice` to the source renderer explicitly. Add a typed targeted `rendererNotice` imperative for browser-only feedback such as “Opened in VS Code”; it is transient renderer feedback, not the global notice triple in `ArchState`. Record this narrow exception in the state contract rather than representing it as browser-authored local logic state.

Add explicit browser lifecycle messages, validated like all other inbound messages:

- `rendererVisibilityChanged`;
- `rendererFocusChanged` (mandatory — attention arbitration in §8.3 depends on it);
- the existing `ready`, `refreshState`, and render-evidence messages remain authoritative for synchronization.

### 5.3 JSON compatibility and bounds

VS Code structured clone and WebSocket JSON are not identical. All protocol fields must be valid JSON and must not rely on preserving `undefined`, class instances, typed arrays, `BigInt`, or cycles.

- **Fail-closed browser ingress schema.** The existing `validateWebviewToHostMessage` (`shared/protocol-validation.ts`) is audit-only — `SidebarViewProvider` logs and drops only render-evidence types, and `MessageRouter` handlers perform ad-hoc per-message checks that surface “Protocol defect” notices. That posture is acceptable for the trusted webview, **not** for browser ingress. Add a new exact, bounded `validateBrowserToHostMessage` (new `shared/browser-ingress.ts` or equivalent) applied after JSON parsing and **before** `MessageRouter`: unknown fields are rejected (not ignored), wrong types rejected, every string/array length and nesting depth bounded, and `extensionUiResponse` payloads validated against their closed schema rather than arbitrary JSON. Base64 is rejected everywhere except the explicitly enumerated `imageBlob` field(s) and the closed `ComposerInputDraft` input field; those paths use strict base64 decoding and the attachment bounds below. A failing message is never routed; repeated violations (≥ 5 within a bounded window) close the socket with a typed reason.
- **Attachment bounds and persistence.** A known `imageBlob`/`ComposerInputDraft` image variant carries only its strict base64 value and declared image metadata; its decoded raw image is at most 10 MiB per image, aggregate raw image inputs are at most 20 MiB per composer/message, its encoded value is at most `4 × ceil(10 MiB / 3)` bytes per image, and the complete JSON command/frame including all known image payloads and envelope overhead must remain within the 32 MiB transport record limit. The browser ingress schema is closed: `filesystemPathRef` has no base64, `kind: 'imageBlob'` is the only `ComposerInputDraft` blob variant admitted in the local MVP, and the existing `kind: 'fileBlob'`/arbitrary browser `File` variant is rejected until Milestone 4. Base64/data payloads are rejected in every other field, including extension-UI responses and arbitrary command metadata. `addComposerInput` is the bounded image transfer: after validation the host copies accepted bytes into host-owned `pendingComposerInputs` and emits an accepted ack. The browser retains its staging bytes in live page memory until that ack and a confirming snapshot show the host-owned input metadata/identity; the later `send` consumes those host-owned inputs. The browser never writes image bytes, base64, data URLs, `Blob`s, or `ArrayBuffer`s to the 64 KiB `sessionStorage` mirror, which stores only bounded metadata/fingerprint (for example MIME type, raw byte length, digest, and client command ID). On reconnect or reload, reconciliation follows the §5.2 precedence: the bounded host command-decision ledger is queried first; an `accepted` decision is authoritative even when the snapshot no longer shows the input (it may have been consumed by a `send` or removed by another authoritative host action), and the UI follows the snapshot with no reattach prompt; a `rejected` decision restores from page memory or asks to reattach; a `notFound`/`expired` ledger answer plus a snapshot confirming the input's absence means the transfer was never accepted, so the browser restores from page memory or asks to reattach. Snapshot presence/identity can confirm acceptance early, but snapshot absence alone never proves rejection; the browser never replays the image. Sending from another renderer is valid only after that renderer observes the host confirmation. The validator measures decoded bytes and full frame size, not only string length.
- Set WebSocket `maxPayload` consistently with Pie's existing 32 MiB record boundary.
- Reject binary frames initially.
- Bound handshake time (10 s), connection count (4 concurrent browser renderers), queued send bytes (8 MiB per socket, latest-wins), and malformed-message rate.
- A protocol/version/asset mismatch closes the browser socket with a typed reason and allows the page to reload once; it must not create an unbounded reload loop.

### 5.4 Detail subscription ownership (joint with SESSION_RUNTIME_ISOLATION_PLAN Phase 5)

Browser detail delivery is **not** independent runtime work. `SESSION_RUNTIME_ISOLATION_PLAN.md` Phase 5 defines the closed `detail.subscribe`/`detail.unsubscribe` protocol and the `HostDetailRoute` (`hostInstanceId`, `hostGeneration`, `viewGeneration`, `backendGeneration`, `coordinatorGeneration`, `workerId`, `workerGeneration`, `detailKey`, `subscriptionId`). The complete browser subscription ownership key is `{hostInstanceId, viewGeneration, rendererId, rendererGeneration, detailKey}`. Here `viewGeneration` is the shared host/view fence from Phase 5; it is not a replacement for the per-connection `rendererGeneration`. `subscriptionId` and the backend/worker generations remain correlation and execution fences, not substitutes for either identity.

- **Trusted renderer identity in the route.** `HostDetailRoute` gains the renderer hub's trusted `rendererId` and `rendererGeneration` (never client-supplied) alongside `viewGeneration`. A browser renderer's subscription can never be settled or streamed to another renderer, even with matching numeric revisions; tombstones use the complete ownership key above.
- **Targeted stream/page/unsubscribe/tombstone behavior.** Subscribe/unsubscribe route through the owning renderer session; baseline/pages/deltas/terminal stream only to the subscribing renderer; collapse/unmount sends `detail.unsubscribe`; the host keeps a bounded tombstone until acknowledgement, worker/backend death, or expiry, and drops late start/page/delta/terminal traffic matching the full key.
- **Two valid sequencing cases.** (1) **Joint landing:** Phase 5 and this browser work land together, and the Phase 5 route includes trusted `rendererId`/`rendererGeneration` from the outset; one coordinated protocol bump/migration and the corresponding `sync-contract.test.ts` updates cover that landing. (2) **Phase 5 first:** Phase 5 may land with its public detail protocol first; browser detail acceptance is deferred, then a later browser change adds the trusted renderer fields and complete ownership key through a **second protocol bump/migration** with its own contract-test update. The browser plan does not require both changes to share a bump. In either case the earlier `requestDetail`/`detailResult` correlation sketch is superseded by Phase 5's subscription protocol and is not implemented.
- **Tests.** The contract suite tests migration for the sequencing case that actually occurs—joint landing or Phase 5-first with the second bump; it does not require both mutually exclusive histories. Whichever branch lands must end with cross-renderer detail leakage rejection, post-unsubscribe traffic drops, tombstone expiry, per-renderer generation fences, and key-scoped updates with a browser renderer as one of the subscribers.

## 6. Embedded HTTP/WebSocket server

Create a service under a dedicated host boundary, for example:

```text
extension/src/host/browser-server/
  browser-server.ts
  browser-renderer-transport.ts
  static-assets.ts
  policy.ts
  types.ts
```

### 6.1 HTTP surface

Keep the route set minimal:

| Route | Purpose |
|---|---|
| `GET /` | Manifest-derived HTML shell |
| `GET /assets/<hashed-file>` | Compiled JS/CSS/chunks from `out/webview/panel` |
| `GET /favicon.svg` (optional) | Pie icon |
| `GET /health` | Local readiness only; no state or environment details |
| `Upgrade /ws` | Browser renderer transport |

There are no generic APIs, backend RPC routes, filesystem routes, upload routes, or command endpoints in the first milestone.

Static serving requirements:

- resolve files only from the compiled webview asset directory;
- manifest/allowlist resolution, not arbitrary path joining;
- correct MIME types and `X-Content-Type-Options: nosniff`;
- no-cache HTML and manifest; immutable caching for hashed assets;
- strict method and path allowlists;
- bounded headers and no directory listing;
- a browser CSP permitting only same-origin scripts/styles/assets and same-origin `ws:`/`wss:` connections; `style-src` also allows inline styles (DOMPurify-sanitized content and the self-contained render-crash overlay), while `script-src` stays nonce-only;
- `frame-ancestors 'none'`, no remote scripts, and no inline script except a nonce if bootstrap data requires it.

Extract generic manifest loading, entry discovery, asset hashing, and HTML metadata from `host/webview/assets.ts`. Keep separate renderers for VS Code URIs/CSP and ordinary HTTP URLs/CSP.

### 6.2 Local configuration

Declare settings in `extension/package.json` and read them through VS Code configuration:

| Setting | Default | Initial behavior |
|---|---:|---|
| `pie.browserServer.enabled` | `true` | Start automatically when Pie activates |
| `pie.browserServer.port` | `1997` | Preferred loopback port; valid range `1..65535` |
| `pie.browserServer.requirePreferredPort` | `false` | When true, fail instead of falling back if the preferred port is occupied |

Do not add a bind-address setting initially. The service always binds `127.0.0.1`.

VS Code can run one Pie extension host per window. The first window normally owns the preferred port. If it is occupied and `requirePreferredPort` is false, another window binds an OS-assigned loopback port, records the actual URL in its service state, and its Open/Copy commands use only that URL. It must never open the preferred-port URL merely because another Pie window owns it. The served page title/bootstrap identifies the owning workspace, making accidental wrong-window attachment visible. The current `hostInstanceId` comes only from `rendererHello` and may be displayed from that live connection state; it is never baked into potentially stale HTML. For authenticated internet ingress, the chosen window uses `requirePreferredPort: true` and an explicitly configured stable port. Public-origin configuration is instance/workspace-scoped and carries the expected host/workspace identity; ownership and fail-closed behavior are specified in §10.3.

Lifecycle outcomes are explicit and deduplicated:

- successful preferred-port startup: one informational log, no notice;
- successful fallback bind: one informational log containing the actual loopback URL, no global notice;
- strict `EADDRINUSE` or another bind failure: one error log and one actionable global notice;
- successful command-driven restart: one informational log and command completion message;
- ordinary shutdown: one debug/informational lifecycle log, no notice.

`pie: Restart Browser Server` performs an atomic stop and re-reads current settings. If `enabled` is false, it leaves the server stopped and reports that the feature is disabled; otherwise it attempts a new bind. Port/enabled changes therefore do not require an extension reload. Open/Copy use only the service's recorded actual URL. When disabled they report how to enable the setting; after a failed bind they report the existing actionable failure and never open or copy a stale/preferred URL.

### 6.3 Local security boundary

Local mode is intentionally low-friction but must still prevent ordinary web-origin attacks against a command-capable loopback service:

- listen only on `127.0.0.1`, never all interfaces;
- validate `Host` against the canonical loopback host/port to reduce DNS-rebinding risk;
- accept WebSocket upgrades only from the exact served origin;
- reject missing, `null`, wildcard, foreign, and extension-webview origins on the browser endpoint;
- use a server-created renderer ID and generation; never trust client identity;
- expose no secrets in URL query parameters, logs, HTML, or health output;
- apply connection/payload/rate bounds and strict protocol validation;
- set CSP, clickjacking, sniffing, and referrer headers;
- keep backend credentials and raw backend RPC entirely behind the host boundary.

A separate bearer login is not required for the loopback-only milestone. A local process can already act with the user's authority; the browser-origin controls prevent remote websites from driving the loopback agent through a victim browser.

## 7. Lifecycle and ownership

`PieExtension` owns the browser server. Do not start a listener at module import time.

Recommended lifecycle:

1. Construct the renderer hub and sidebar adapter during `PieExtension` construction.
2. During `PieExtension.start()`, initialize the server after the host can build a valid initial `ViewState`. Backend readiness can remain a field in that state; the HTTP shell need not wait indefinitely for provider/backend startup.
3. Keep the listener alive across an explicit backend restart. Browser renderers observe backend readiness/failure through normal host state.
4. On extension shutdown:
   - stop accepting HTTP/upgrades;
   - close tracked WebSocket clients;
   - close/await the HTTP server;
   - dispose renderer sessions/hub;
   - continue the existing service/backend shutdown order.
5. Make start/stop idempotent and handle a delayed `listen()` completing after shutdown has begun.
6. Never let an old extension generation retain the port or post into a replacement host.

Use `ws` as a direct extension runtime dependency and `@types/ws` as a development dependency. The Node build bundles runtime dependencies into `out/extension.js`; do not rely on the VSIX containing `node_modules`.

## 8. Browser resilience and mobile UX

### 8.1 Connection behavior

The browser transport has four visible states: connecting, connected, reconnecting, and disconnected.

- Initial connection sends the existing ready/refresh handshake.
- Unexpected close uses bounded exponential backoff with jitter.
- Reconnection creates a new renderer registration/generation and requests a full snapshot.
- Application commands are not replayed automatically.
- A compact connection banner is shown only while not connected; it must not replace or mutate authoritative session state.
- Browser backgrounding sends visibility state before timers are throttled where possible. A hidden renderer does not trigger reload escalation for missed paint/commit evidence.
- Foreground return sends visibility plus `refreshState` and recovers from a full snapshot.

### 8.2 Same UI, browser-safe layout

Retain the current stylesheet and components. Add only compatibility work required by ordinary/mobile browsers:

- correct `100dvh` behavior and safe-area insets;
- composer visibility above the mobile software keyboard;
- touch-sized controls and non-hover access to actions;
- drawer/overflow behavior for narrow session tabs and settings;
- prevent horizontal transcript/tool overflow;
- browser clipboard permission fallbacks;
- test current breakpoints at 390x844, 430x932, 768x1024, and desktop widths.

**Browser evidence policy.** Automated tests use exactly the Chromium, Firefox, and WebKit revisions bundled by a pinned Playwright version recorded in the lockfile; each run records the Playwright version and browser revisions/versions. Release smoke uses current stable desktop Chrome and Firefox plus one real iOS Safari 17+ device and one real Android Chrome 120+ device, with the versions/devices recorded in §12.2. Emulation may cover layout but does not count as mobile release evidence. These are the only support/evidence claims: do not claim Edge or desktop Safari support.

**Mobile acceptance.** Keyboard: composer focus, Enter to send, Escape to dismiss, no viewport jump. Safe area: notch/home-indicator content is never obscured. Clipboard: paste image, copy text, permission fallbacks. Touch: controls ≥ 44 px, no hover-only actions, drawer/overflow reachable without hover.

Add a web app manifest and icons only after the local browser flow is stable. Do not add a service worker initially; stale cached UI/protocol code is more dangerous than the small offline benefit.

### 8.3 Attention arbitration

Completion attention is host-owned and arbitrated so that **only visible eligible** renderers can receive it, independent of VS Code window focus:

1. Renderers report `rendererVisibilityChanged` and `rendererFocusChanged` (§5.2). An eligible renderer is connected, registered, ready for imperatives, and visible. The hub assigns a monotonic `focusEpoch` on each accepted focus transition and a `visibilityEpoch` on each transition to visible; client timestamps are not trusted.
2. On completion, the hub considers only visible eligible renderers and chooses by this deterministic priority: the focused browser renderer with the greatest `focusEpoch`; otherwise the visible browser renderer with the greatest `visibilityEpoch`; otherwise the visible VS Code sidebar. Stable `rendererId` order breaks an epoch tie.
3. The chosen renderer receives the typed attention imperative (browser: sound/visual indication; sidebar: `requestWindowAttention` in `host/sidebar/completion-notification.ts`). No other renderer receives renderer sound/UI attention. If every renderer is hidden or ineligible, the recipient set is empty; an optional desktop OS flash is a separate current-host policy and is not a renderer recipient.
4. A blur (`rendererFocusChanged(false)`), disconnect, or transition to hidden clears that renderer's focused state and stale focus epoch before the next arbitration. VS Code window focus state is not consulted: arbitration uses only the host's renderer visibility/focus beliefs.

Tests: focused visible browsers are selected by latest focus epoch; with no focused browser, latest visible browser wins over a visible sidebar; focus change reroutes attention; blur, disconnect, or hidden clears stale focus; hidden renderers never receive attention; all-hidden produces zero renderer recipients; VS Code window focus state does not change the arbitration outcome.

## 9. Browser-native capability follow-up

The minimum source-aware confirmation seam lands in Milestone 2 with transport parity, rather than being deferred to browser-native viewers. It routes model-switch confirmation and destructive `revertFile` confirmation by trusted initiating renderer; it must not add browser branches throughout the reducer.

```ts
interface RendererConfirmationCapabilities {
  confirmModelSwitch(request: ModelSwitchRequest, source: RendererCommandContext): Promise<boolean>;
  confirmDestructive(request: DestructiveActionRequest, source: RendererCommandContext): Promise<boolean>;
}

interface RendererCapabilities extends RendererConfirmationCapabilities {
  openFile(request: OpenFileRequest, source: RendererCommandContext): Promise<void>;
  openDiff(request: OpenDiffRequest, source: RendererCommandContext): Promise<void>;
  chooseAttachments(source: RendererCommandContext): Promise<AttachmentSelection>;
  showLogs(source: RendererCommandContext): Promise<void>;
}
```

For Milestone 2, both confirmation methods send a host-owned, targeted inline confirmation imperative to the initiating browser renderer and proceed only on that renderer's explicit response. If that renderer disconnects, the confirmation rejects/cancels. The VS Code adapter may map the same source-aware seam to its existing native modal for a VS Code source, but it never invokes an invisible desktop modal for a browser source. This seam is the basis for the model-switch and revert claims in §2.2 and Milestone 2.

Milestone 4 extends the adapter for browser-native file/diff/log views, exports, and repository-path attachment selection:

1. Make the existing direct `import('vscode')` open-file effect injectable.
2. Keep VS Code implementations unchanged.
3. Add host-backed, read-only browser file content and diff projections through narrow typed effects/imperatives.
4. Render previews in the shared UI using host-owned state or targeted bounded responses consistent with `STATE_CONTRACT.md`.
5. Add browser download/export and repository-path attachment selection.

Do not expose arbitrary paths over HTTP. Resolve and authorize every file request against the active workspace/cwd and the existing host command path.

## 10. Internet exposure phase

Internet access is a separate release gate, not a configuration toggle in the local MVP.

### 10.1 Deployment shape

Keep Pie bound to loopback:

```text
Browser
  -> HTTPS authenticated edge
  -> outbound tunnel process on the host
  -> http://127.0.0.1:<configured-stable-port>
  -> Pie RendererHub
```

Cloudflare Tunnel + Access is the first intended adapter because only the host needs setup; remote devices use an ordinary browser and identity login. Pie must not manage router forwarding or bind publicly.

### 10.2 Required hardening before enabling

- HTTPS-only public origin.
- Explicit configured public origin; no wildcard CORS/origin policy.
- **Mandatory application-level identity verification.** The Pie server verifies the Access JWT itself at the application boundary: signature against a bounded cached JWKS (refresh on failure), exact issuer match, exact configured audience match, and `exp`/`nbf`/`iat` checks with a bounded clock skew (≤ 60 s). An unsigned forwarding header is never trusted.
- **Expiry timer and reconnect/reauth.** The server tracks token expiry per socket and closes with a typed reason at expiry; the browser re-authenticates through the secure session/bootstrap flow with bounded reauth attempts (≤ 3) before showing an error state.
- **Bounded revocation latency.** Revocation latency is bounded by a short token lifetime (≤ 5 min) plus an immediate revocation check on each bootstrap; the deployment documentation states that revoked access takes effect within that bound.
- **Scope.** Unauthenticated rejection applies only to the configured public origin; the local loopback origin remains unauthenticated and is always available for recovery.
- Secure, HTTP-only, same-site session/bootstrap flow suitable for WebSocket upgrade; no bearer token in query strings.
- Bounded concurrent clients and message rate.
- Audit records for connect/disconnect, identity, command class, and rejection without transcript/credential leakage.
- Security review of attachments, clipboard, file/diff preview, extension-UI prompts, and computer-use controls.
- Explicit warning that authenticated Pie access is equivalent to command execution and file access as the host user.
- End-to-end tests through a TLS/auth reverse-proxy fixture before real exposure, with the acceptance cases in §10.4.

The public origin may be added to CSP and WebSocket origin policy only when authenticated ingress is configured and healthy. Local origin remains available for recovery.

### 10.3 Public-origin ownership and multi-window safety

Public-origin configuration is instance/workspace-scoped, not global:

- The public config (for example `pie.browserServer.publicOrigin` plus the expected host/workspace identity) is recorded per workspace and applies only to the window that owns the configured stable port (`requirePreferredPort: true`).
- Before serving public traffic, the server verifies tunnel health and identity: the configured edge is reachable, the request's expected host/workspace identity matches this instance, and this window owns the configured port.
- **Fail closed on wrong-window ownership.** If public traffic reaches a window that does not own the configured port/identity — including a second VS Code window that bound a fallback port — the server rejects the request/socket with a typed reason and records one audit entry. It never serves the public origin from a non-owning instance.
- Two-window test: window A with public config serves the public origin; window B without config (or a different workspace) must not serve it, and a browser attached to B fails closed with a clear error.

### 10.4 Public-origin acceptance

Through a TLS/auth reverse-proxy fixture, before real exposure:

- An unauthenticated or wrong-origin request cannot fetch state or upgrade a socket (401/403, no state leakage).
- A token with a wrong issuer, wrong audience, bad signature, or expired `exp` is rejected; a valid token is accepted.
- Token expiry mid-session disconnects the socket with a typed reason; re-authentication succeeds within the bounded reauth attempts.
- Revocation takes effect within the documented bound (token lifetime ≤ 5 min plus the bootstrap revocation check).
- The local loopback origin still works unauthenticated while the public origin rejects unauthenticated traffic.
- The two-window ownership test (§10.3) passes: only the owning window serves the public origin.

## 11. Implementation milestones

### Milestone 0 — Contract and test harness

**Changes**

- Record the multi-renderer ownership rules in `STATE_CONTRACT.md`.
- Define renderer/session/transport interfaces.
- Extend protocol types and validation; bump protocol version.
- Define the fail-closed browser ingress schema (`validateBrowserToHostMessage`) and the `clientCommandId`/`commandAck` protocol types.
- Build fake host and client transports for deterministic tests.

**Acceptance**

- Two fake renderers receive independent snapshots.
- Renderer A's evidence cannot advance renderer B's ledger.
- Blocking A never delays B.
- Disposing/replacing one renderer does not reset host state or the other renderer.
- The browser ingress schema rejects unknown fields, wrong types, oversized strings/arrays, base64 outside the allowlisted `imageBlob`/`ComposerInputDraft` paths, over-limit decoded images/full frames, and malformed extension-UI payloads before routing; bounded valid image inputs and other valid messages pass unchanged.

### Milestone 1 — Renderer hub with the existing sidebar

**Changes**

- Introduce `RendererHub` and per-renderer delivery owner.
- Project and JSON-normalize the `ViewState` once per logical render; optionally encode one shared immutable state body, then assemble each renderer's envelope as specified in §4.1.
- Adapt `SidebarViewProvider` to register one VS Code transport.
- Route state scheduling and imperatives through the hub.
- Preserve existing hot reload, readiness probe, watchdog, and visibility behavior.

**Acceptance**

- Sidebar UX and reliability smoke tests remain unchanged.
- No browser server exists yet, but all single-renderer behavior passes through the new abstraction.
- Existing state-delivery and provider tests pass without weakened assertions.
- One logical render produces exactly one expensive projection/JSON-safe normalization (and, when used, one shared state-body encoding); each browser renderer gets its own bounded envelope containing its own `rendererId`, `rendererGeneration`, and `revision`, while VS Code receives an object envelope through structured clone.

### Milestone 2 — Shared client transport and local server

**Changes**

- Extract `ClientTransport` from `panel.tsx`/`use-host-sync.ts`.
- Preserve the VS Code client transport.
- Add browser WebSocket transport and bootstrap metadata.
- Add manifest-backed HTTP static serving and browser renderer registration.
- Add settings, commands, lifecycle, CSP, origin/host validation, and `ws` dependency.
- Wire the fail-closed browser ingress schema before `MessageRouter`; add `clientCommandId`/`commandAck`, the bounded `addComposerInput` transfer/ack, host-owned `pendingComposerInputs` ownership and snapshot confirmation, the bounded pending-command store, and the uncertain-UI/status-reconciliation state (§5.2–§5.3).
- Add pre-send gates (bufferedAmount, client count, snapshot size) and latest-wins coalescing for lagging browsers (§4.1).
- Add the minimal source-aware confirmation capability for model-switch confirm and destructive revert: a host-owned inline imperative for browser sources, with explicit source routing and cancellation (§2.2, §9).
- Browser detail subscription work follows the Phase 5 sequencing case that actually occurs (§5.4); its migration is tested without requiring the mutually exclusive alternative, it is not implemented against the superseded `requestDetail`/`detailResult` correlation, and it does not require the same protocol bump when Phase 5 landed first.

**Acceptance**

- `pie: Open in Browser` opens the actual URL owned by that extension host; `pie: Copy Browser URL` copies the same URL; `pie: Restart Browser Server` re-reads settings and rebinds atomically.
- The first active window normally serves on `http://127.0.0.1:1997`; a second VS Code window uses and reports a distinct fallback port rather than attaching to the first window's host.
- The browser can list/open/create sessions, send/stream/interrupt, switch models, expand tool details, and answer extension-UI prompts.
- Sidebar and browser converge on the same active state.
- Browser reload/reconnect receives a fresh `rendererHello` and full snapshot without stale-generation rejection or duplicate execution.
- Every schema-valid browser application command that reaches routing has exactly one host decision and one host-side ack emission. The client observes `accepted`/`rejected` when delivered or `unknown` when a close loses the ack; host-received-before-close, never-received, and bounded status reconciliation are covered with no automatic replay (§5.2).
- `addComposerInput` is a bounded transfer: accepted-before-close retains the host-owned input after the browser closes, never-accepted does not create host state, delayed send consumes host state, and a second renderer can send only after snapshot confirmation; reload/reconnect reconciles acceptance by the §5.2 precedence — the host command-decision ledger is queried first, `accepted` is authoritative even when the input is absent from the snapshot, snapshot presence confirms acceptance early, and reattach is prompted only when neither the ledger nor the snapshot confirms acceptance and page memory is gone.
- A browser-initiated detail subscription and capability notice return only to that browser renderer (Phase 5 route with trusted `rendererId`/`rendererGeneration` and complete key `{hostInstanceId, viewGeneration, rendererId, rendererGeneration, detailKey}`); migration coverage matches the Phase 5 landing sequence that actually occurs, and either branch ends with the complete ownership key.
- Browser model-switch confirm and destructive confirmations render inline through the M2 source-aware seam in the initiating renderer; the host proceeds only on explicit confirm, and disconnect cancels the pending confirmation.
- A lagging browser is coalesced to the latest snapshot and never queues an unbounded backlog; reducer/effect/backend dispatch continues while a browser socket is blocked.
- Closing a VS Code window releases the port owned by that window.
- The listener is unreachable on LAN interfaces.
- Startup, fallback, conflict, restart, disabled-command, and shutdown paths each produce the lifecycle outcome specified in §6.2—successful fallback is info-log-only, while only a terminal bind/start failure produces a notice—without affecting backend execution.

### Milestone 3 — Resilience and mobile browser pass

**Changes**

- Visibility-aware reconnect and recovery.
- Connection-status UI.
- Host-owned attention arbitration with at most one visible eligible renderer, deterministic focus/visibility epochs, and zero renderer recipients when all are hidden (§8.3).
- Mobile viewport, keyboard, touch, overflow, and safe-area fixes.
- Playwright browser-matrix suite and the real-device evidence checklist (§8.2, §12.2).
- Optional web app manifest/home-screen installability without service-worker caching.

**Acceptance**

- Background/foreground and network interruption recover without agent interruption.
- A hidden browser does not trigger a recovery storm.
- At most one visible eligible renderer receives completion attention per completion, independent of VS Code window focus; latest focus/visibility priority and stale-focus clearing are enforced; all-hidden produces zero renderer sound/UI recipients.
- Core send/interrupt/ask-user flows work at representative phone/tablet viewport sizes.
- Automated browser evidence uses the exact pinned Playwright browser revisions and records their versions; release smoke uses current stable desktop Chrome and Firefox plus at least one real iOS Safari 17+ and one real Android Chrome 120+ device, with the §12.2 evidence recorded.
- Sidebar remains responsive while the browser is throttled or disconnected.

### Milestone 4 — Browser-native file/diff/export capabilities

**Changes**

- Extend the M2 confirmation seam for browser-native read-only file/diff viewers and typed host-backed capability responses.
- Browser-native attachment selection and exports/downloads.
- Browser notification behavior.

**Acceptance**

- Remote-browser actions no longer depend on watching the desktop VS Code window for core review workflows.
- Path and payload bounds are enforced and covered by tests.

### Milestone 5 — Authenticated internet ingress

**Changes**

- Public-origin configuration and CSP, scoped per instance/workspace with expected host/workspace identity (§10.3).
- Mandatory application-level Access JWT verification (issuer/audience/JWKS, expiry with bounded clock skew), expiry timer, and bounded reauth (§10.2).
- Authenticated reverse-proxy WebSocket session bootstrap.
- Security/audit/rate-limit gates.
- Deployment documentation for Cloudflare Tunnel + Access.

**Acceptance**

- §10.4 acceptance passes through a TLS/auth reverse-proxy fixture: unauthenticated/wrong-origin requests rejected; wrong issuer/audience/signature/expired tokens rejected; valid tokens accepted; mid-session expiry disconnects and reauth succeeds within bounds; revocation takes effect within the documented bound.
- An authenticated browser needs no local client installation.
- Revoked/expired access disconnects and cannot reconnect.
- The two-window ownership test passes: only the owning window serves the public origin; a non-owning window fails closed.
- The local loopback origin remains unauthenticated and functional while the public origin rejects unauthenticated traffic.
- Pie itself still listens only on loopback.

### Milestone 6 — Optional VS Code-independent host

Only pursue if keeping VS Code open becomes a meaningful limitation. Extract VS Code-owned startup, persistence, configuration, modal, and file/diff capabilities behind host adapters and run the same renderer hub/backend client from a standalone Node entry point. This is intentionally deferred; the embedded server proves the UX and transport with much less risk.

## 12. Verification strategy

### 12.1 Unit and contract tests

Add focused coverage under:

- `extension/test/host/sidebar/` or a new `host/renderers/` group:
  - independent delivery ledgers;
  - cross-renderer evidence rejection;
  - visibility and recovery isolation;
  - targeted imperative routing, including Phase 5 detail subscription ownership (§5.4) and renderer notices;
  - source-targeted ready/refresh/requestSnapshot behavior and shared selection fan-out;
  - a blocked browser socket while reducer/effect/backend dispatch continues;
  - registration/disposal races.
- `extension/test/shared/protocol/`:
  - protocol version and envelope contract;
  - renderer lifecycle validation;
  - fresh `rendererHello` identity on reconnect and stale-identity rejection;
  - request/response correlation for renderer-targeted imperatives;
  - fail-closed browser ingress schema: unknown fields, wrong types, oversized strings/arrays, base64 outside the allowlisted `imageBlob`/`ComposerInputDraft` image paths (including `fileBlob` rejected before Milestone 4), decoded images above 10 MiB, full frames above 32 MiB, and malformed extension-UI payloads rejected before routing;
  - bounded valid image inputs and `addComposerInput` ownership lifecycle: accepted-before-close, never-accepted, delayed send consuming host state, cross-renderer send only after snapshot confirmation, cross-renderer-consumed-before-reconnect (ledger `accepted` with the input absent from the snapshot, no reattach prompt), and reload/reconnect resolution by the §5.2 precedence; image bytes never enter `sessionStorage`, and an unconfirmed image prompts reattachment only when neither the ledger nor the snapshot confirms acceptance and page memory is gone;
  - host decision/emission exactly once versus client-observed `accepted`/`rejected`/`unknown`, duplicate-ID handling, status reconciliation, and pending-command store bounds;
  - the Phase 5 migration for whichever landing sequence actually occurs (joint or Phase 5-first with a second protocol bump), followed by the complete ownership key;
  - JSON round trips and size bounds.
- `extension/test/webview/`:
  - VS Code and browser transport handshakes;
  - inbound subscription abstraction;
  - reconnect without command replay;
  - uncertain-UI resolution, command-status reconciliation, and draft restoration from the authoritative snapshot;
  - image transfer reload/reconnect with no page-memory payload: the ledger decision is queried first, snapshot identity confirms host acceptance early, and the UI tells the user to reattach only when neither the ledger nor the snapshot confirms acceptance; no image replay;
  - connection-status rendering;
  - existing app smoke/evidence ordering through both adapters.
- `extension/test/host/browser-server/`:
  - loopback-only bind;
  - manifest/static route allowlist and traversal rejection;
  - CSP/security headers;
  - Host/Origin/upgrade rejection;
  - malformed/oversized/binary WebSocket messages;
  - large-snapshot event-loop latency: one shared projection/JSON-safe normalization and optional shared state-body encoding per logical render, followed by each browser's bounded renderer-specific envelope assembly/serialization; a 10 ms ticker records p95 and maximum delay while max-budget data is sent, with no delivery turn over 100 ms and a target p95 ≤ 50 ms;
  - pre-send gates: bufferedAmount drop/coalesce, client-count cap, snapshot-size cap;
  - host-received-before-close (one host decision/emission, zero observed acks), ack-observed accepted/rejected, never-received, duplicate-ID, and status-reconciliation cases;
  - attention arbitration priority (latest focus epoch, then latest visible browser, then visible sidebar), stale-focus clearing, and zero renderer recipients when all are hidden;
  - ingress rejection rate bound (≥ 5 violations closes the socket);
  - preferred-port conflict, fallback allocation, delayed start, atomic restart, idempotent shutdown, and active-client shutdown;
  - two server instances opening/copying only their own actual URLs;
  - exactly one expected notice/log outcome for terminal bind/start failures, and no notice for a successful fallback (which has an informational log).
- `extension/test/browser/` (repeatable Playwright suite):
  - exact Chromium, Firefox, and WebKit revisions bundled by the pinned Playwright version in the lockfile; record the Playwright and browser versions for every run;
  - keyboard, safe-area, clipboard, and touch acceptance;
  - release smoke evidence on current stable desktop Chrome and Firefox plus one real iOS Safari 17+ and one real Android Chrome 120+ device; do not claim Edge or desktop Safari support.
- `extension/test/integration/public-origin.test.ts` (TLS/auth reverse-proxy fixture):
  - unauthenticated/wrong-origin rejection; wrong issuer/audience/signature/expired-token rejection; valid-token acceptance;
  - mid-session expiry disconnect and bounded reauth; revocation within the documented bound;
  - two-window public-origin ownership fail-closed (§10.3).
- `extension/test/integration/manifest-commands.test.ts` (or the owning manifest contract suite):
  - settings defaults and bounds;
  - Open/Copy/Restart command declarations and registration.

Use real loopback HTTP/WebSocket integration tests on ephemeral ports (`0`) while production prefers `1997` and records the actual per-window port.

### 12.2 Manual acceptance matrix

Run the existing UX reliability smoke tests plus:

| Scenario | Sidebar | Local browser | Expected |
|---|---|---|---|
| Initial activation | open/closed | open | Browser receives full state |
| Concurrent views | open | open | Shared session/state; independent scroll/focus |
| Long streaming/tool turn | open | open | Both progress; neither blocks the other |
| Browser backgrounded | open | hidden | Sidebar remains live; browser resnapshots on return |
| Browser refresh mid-turn | open | reload | No replay; live turn restored from host snapshot |
| Backend restart | open | open | Listener survives; both show readiness/recovery |
| Preferred port occupied, fallback allowed | open | open on fallback URL | Commands target the correct window/host; no wrong-host attachment; informational log only, no notice |
| Preferred port occupied, fallback forbidden | open | unavailable | Terminal bind failure produces one clear notice/log; sidebar/backend unaffected |
| Two VS Code windows | open in both | one browser per URL | Distinct host/workspace identity and state; no cross-attachment |
| Extension shutdown | closing | open | Socket closes and port is released |
| Mobile viewport | n/a | emulated/real | Composer, prompts, tabs, and tools remain usable |
| Model-switch confirm | open | open | Inline host-owned confirm in the initiating renderer; no invisible desktop modal |
| Destructive revert | open | open | Inline confirm; host proceeds only on explicit confirm |
| Completion attention | open | two visible browsers | Latest focused browser wins; otherwise latest visible browser wins; hidden renderer never receives; all-hidden yields zero renderer sound/UI recipients |
| Release browser smoke | n/a | current stable desktop Chrome and Firefox | Core smoke passes; browser versions are recorded; do not claim Edge or desktop Safari |
| Real iOS Safari / Android Chrome | n/a | one real device per platform | iOS Safari 17+ and Android Chrome 120+ pass §8.2 keyboard/safe-area/clipboard/touch acceptance; evidence recorded per release |

### 12.3 Commands

Use focused tests during each milestone, then the repository gates:

```bash
npm run test:file -- extension/test/host/renderers/renderer-hub.test.ts
npm run test:file -- extension/test/host/browser-server/browser-server.test.ts
npm run test:file -- extension/test/webview/components/browser-transport.test.ts
npm run typecheck
npm run extension:build
npm test
cd extension && npm run package
```

Any edit under `extension/src/` requires the extension build, which also syncs output to the installed extension.

## 13. Main risks and mitigations

| Risk | Mitigation |
|---|---|
| One renderer's delivery backpressure freezes all views | One delivery controller/readiness/watchdog per renderer |
| Evidence from one renderer settles another | Transport-bound renderer identity and separate accepted ledgers |
| Two surfaces fight over active selection/editing | Declare shared mirror semantics for v1; defer independent client state |
| Reconnect duplicates a send/tool action | Never replay commands; full-snapshot recovery and existing correlation |
| Browser background throttling causes reload storms | Explicit visibility, suspend commit escalation while hidden, resnapshot on foreground |
| UI forks between sidebar and browser | One Vite entry and component tree; transport/bootstrap adapters only |
| VS Code actions have surprising browser behavior | Capability table, source-aware notices, then typed browser-native adapters |
| Loopback service becomes a CSRF/RCE surface | Loopback bind, Host/Origin/CSP validation, strict routes/protocol/bounds |
| Public exposure arrives before authentication | Separate internet milestone and release gate; keep Pie loopback-only |
| Server failure destabilizes Pie | Server is a disposable host service; only terminal bind/start failures surface notices, and no server failure blocks backend/sidebar startup or execution |
| Multiple VS Code windows contend for one port | Preferred-port fallback is instance-specific; commands use the actual bound URL; stable public ingress requires explicit single-owner port configuration |
| Browser reconnect keeps stale renderer generation | Each accepted socket begins with `rendererHello`; browser identity is in memory and replaced before `ready` |
| Existing user work is overwritten during implementation | Keep changes isolated; the current working tree contains unrelated in-progress runtime/session work |
| Large-snapshot work stalls the host event loop | One shared projection/JSON-safe normalization and optional state-body encoding per logical render, bounded per-renderer envelope assembly, `bufferedAmount + frameBytes`/record gates, and the §12.1 latency budget (max 100 ms, target p95 50 ms); worker threads only if measurements justify them |
| Reconnect duplicates or loses a mutation | `clientCommandId`, one host decision/emission, no automatic replay, bounded pending-command store, status reconciliation, time-bounded unknown UI, and ledger-first reconciliation (§5.2) |
| Browser ingress becomes a command surface | Fail-closed exact bounded schema before `MessageRouter`; `addComposerInput` transfers only bounded image data into host-owned `pendingComposerInputs`, the browser keeps no image bytes in `sessionStorage`, and the rejection-rate bound closes the socket (§5.3) |
| Duplicate or missed completion attention | Host-owned arbitration among visible eligible renderers: latest focus epoch, latest visible browser, visible sidebar, or zero renderer recipients; stale focus is cleared (§8.3) |
| Public auth misconfiguration (wrong issuer/audience, expired tokens) | Mandatory application-level JWT verification, expiry timer, bounded reauth, revocation bound (§10.2, §10.4) |
| Wrong window serves the public origin | Instance/workspace-scoped public config, expected identity, tunnel health check, fail-closed ownership (§10.3) |
| Browser fragmentation breaks the UI | Exact browser revisions bundled by the pinned Playwright lockfile are recorded; release smoke covers current stable desktop Chrome/Firefox and one real iOS Safari 17+ and Android Chrome 120+ device, with no Edge or desktop Safari claim (§8.2) |

## 14. Definition of done for the local browser release

The local release is complete when:

1. Pie automatically serves the existing UI on an instance-owned loopback URL while the extension is active, preferring `http://127.0.0.1:1997` for the first window.
2. Open/Copy/Restart Browser Server commands work and always address the calling window's actual server instance.
3. Multiple VS Code windows cannot silently attach a browser to the wrong host/workspace.
4. The sidebar and browser use the same UI build and the same host/backend authority.
5. Core chat/session/model/tool/extension-UI workflows work in both surfaces.
6. Each renderer has isolated delivery, readiness, recovery, and visibility state.
7. Reconnect obtains a fresh transport identity and refresh/reconnect never duplicate mutations or execution.
8. Targeted detail, rejection, and capability feedback cannot leak to another renderer.
9. A stalled or over-limit browser cannot block or await sidebar rendering, reducer/effect dispatch, backend RPC, or agent execution; blocked snapshots are dropped/coalesced under the §4.1 gates.
10. The server has a strict loopback/Host/Origin/CSP/route/payload boundary.
11. Browser-server failure cannot break the sidebar or backend.
12. Contract, unit, integration, build, package, and manual acceptance gates pass.
13. `STATE_CONTRACT.md`, `ARCHITECTURE.md`, extension settings/commands, and user setup documentation describe the shipped behavior.
14. Internet exposure remains disabled until the separate authenticated-ingress gate is completed.
15. One logical render produces one shared projected/JSON-safe state body (and, if used, one shared body encoding), while each browser gets its own bounded envelope with its own `rendererId`, `rendererGeneration`, and `revision`; max-budget shared-body work plus envelope assembly/send meets the §4.1 event-loop budget (10 ms ticker, max delay ≤ 100 ms, target p95 ≤ 50 ms), and a stalled browser cannot block or await reducer/effect/backend work.
16. Every schema-valid browser application command that reaches routing has one host decision and one host-side `commandAck` emission; the client observes `accepted`, `rejected`, or `unknown` when delivery is lost. Reconnect never replays accepted/unknown commands; host-received-before-close, never-received, duplicate-ID, and status-reconciliation cases are tested, and uncertain UI resolves within bounds from authoritative state/status.
17. Browser ingress is fail-closed and exact-bounded before `MessageRouter`; unknown fields/types, oversized strings/arrays, base64 outside bounded `imageBlob`/`ComposerInputDraft` fields, decoded images over 10 MiB, full frames over 32 MiB, and malformed extension-UI payloads are rejected, and repeated violations close the socket. `addComposerInput` transfers bounded image bytes into host-owned `pendingComposerInputs` only after acceptance; a confirming snapshot establishes ownership for the browser, send consumes host state, image bytes never enter the 64 KiB `sessionStorage` mirror, and after reload an unconfirmed image is reconciled by the §5.2 precedence — the bounded host command-decision ledger is queried first, `accepted` is authoritative even when the input is absent from the snapshot, snapshot presence confirms acceptance early, and reattachment is prompted only when neither the ledger nor the snapshot confirms acceptance and page memory is gone.
18. Completion attention is arbitrated host-side among visible eligible renderers by latest focus epoch, latest visible browser, then visible sidebar; stale focus is cleared, all-hidden yields zero renderer sound/UI recipients, and tests cover the separate optional desktop OS flash policy.
19. Automated browser tests use the exact Chromium/Firefox/WebKit revisions bundled by a pinned Playwright version in the lockfile and record versions; release smoke uses current stable desktop Chrome and Firefox plus one real iOS Safari 17+ and one real Android Chrome 120+ device. Edge and desktop Safari are not claimed.
20. Public-origin access requires mandatory application-level identity verification with bounded expiry/revocation; unauthenticated rejection is scoped to the public origin; only the owning window serves the public origin (two-window test).
