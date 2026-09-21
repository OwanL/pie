# Deferred triggers

Behavioral contract for the `defer_trigger` tool and its host-side registry. A
session can register one or more asynchronous conditions—timer, user input,
another session finishing, or a periodic command predicate—and a message to
revisit later. Registration is non-aborting: it persists the trigger and the
current turn continues normally.

Delivery is best-effort while the host and target session are available. A
closed or unavailable target stays retryable (or remains claimed when delivery
may already have started); it is never silently redirected to another session.
This feature does not promise background execution or persistence across a host
restart beyond what the current sidecar/registry implementation can recover.

Runtime code:

- tool: `extensions/deferred-triggers/` (backend process)
- host registry + sidecar store: `extension/src/host/deferred-triggers/`
- shared sidecar paths: `extension/src/shared/deferred-triggers-paths.ts`
- protocol types: `extension/src/shared/protocol/deferred-triggers.ts`
- webview menu: `extension/src/webview/panel/aggregate-stats-strip/deferred-triggers-menu.tsx`

## 1. Public API

`defer_trigger` has three actions:

- `register` — requires a non-empty `message` and at least one trigger. It
  persists the registration and does **not** end or abort the current turn.
- `list` — lists active registrations created by the current session.
- `cancel` — cancels one `triggerId`, or all active registrations created by the
  current session when no id is supplied.

One registration may contain several conditions. They use OR semantics: the
first satisfied condition consumes the whole registration and causes at most
one delivery.

A registration is owned by the calling session. `targetSession` is optional;
when omitted it defaults to the caller. An explicit target is a persisted
session path. Creator ownership is separate from delivery targeting: the
creator remains the only session authorized to list or cancel the registration,
while the target receives the wake. The target must be open when delivery is
attempted.

Trigger kinds:

- `timer(ms)` — fires after the normalized delay.
- `user_input` — is consumed by the next real user message in the target
  session; it does not dispatch a second synthetic message.
- `session_finished` — fires when a matching session finishes streaming. A
  creator's own session is excluded to prevent a self-wake loop. A specific
  watched path or any session may be selected.
- `command` — is polled at a bounded interval. Exit 0 means satisfied, exit 1
  means not yet satisfied, and other evaluation failures remain retryable.
  Command predicates are checked by the safeguard before registration.

## 2. Persistence and ownership

The backend and extension host share an append-only `triggers.jsonl` sidecar.
The host also uses one atomic claim artifact per trigger so multiple host
instances cannot dispatch the same registration concurrently. The sidecar is a
sibling of the sessions directory; `PIE_TRIGGERS_DIR` tells the backend where
to append it.

A new registration has this shape (fields abbreviated):

```jsonc
{
  "id": "…",
  "op": "register",
  "sessionPath": "creator-session.jsonl",
  "targetSession": "target-session.jsonl",
  "triggers": [{ "kind": "timer", "ms": 60000 }],
  "message": "Re-check the report",
  "at": "…"
}
```

`sessionPath` is the creator/owner for new records. `targetSession` is the
session that receives delivery. Older records may omit `targetSession` and use
`note` instead of `message`; replay normalizes those records to target their
creator and preserves the note as the delivery message. Legacy records remain
supported, including legacy cancellation and claim/release/fire operations.

Cancellation is creator-scoped in both layers: the backend validates ownership
before appending a targeted cancel, and host replay/registry cancellation
checks the creator path before removing a targeted trigger. A session that only
knows another trigger's id cannot cancel it.

The host replays registrations, claims, releases, failures, fires, and cancels.
A durable claim is retained until a successful dispatch is acknowledged or a
safe pre-dispatch failure is released. This is the at-most-once boundary:
ambiguous delivery is kept claimed rather than automatically duplicated.

## 3. Host delivery

`DeferredTriggerRegistry` reloads the sidecar, arms timer and command checks,
and receives session/user-input lifecycle events from the host. Before acting on
an event it reconciles the sidecar so a just-appended registration is not lost
to watcher debounce.

Synthetic timer, session-finished, and command deliveries go through the
ordinary reducer `Send` path to `targetSession` and include a stable prefix:

```text
[deferred trigger fired: …]
```

The message includes the required registration message. The transcript mapper
uses the prefix to re-derive the deferred-trigger presentation after reload.
A real `user_input` prompt is already the wake and therefore has no synthetic
send.

Before synthetic dispatch the registry verifies that the target is open. If it
is closed, delivery remains retryable and no fallback target is selected.
Reopening a target may cause eligible retryable work to be reconsidered by the
current registry; callers must not rely on this as a background or restart
execution guarantee.

The atomic claim/release/fire machinery protects delivery across host
instances. Claim artifacts, owner-death recovery, dispatch-started evidence,
and retryable diagnostics are projected into the UI without permitting a
second dispatch after an ambiguous boundary.

## 4. Webview and guidance

`ViewState.deferredTriggers` projects creator, target, condition, message,
delivery state, and registration time. The status-strip menu shows the target
(and creator when different) and offers cancellation using the creator path.
Session indicators follow the delivery target.

After a wake, guidance is to re-evaluate the pending task and either complete
it or call `defer_trigger` with `register` again if another condition is
needed. Child subagents cannot use `defer_trigger`; the skill pruner protects
it during a deferred-trigger wake but may prune it on an ordinary turn.

## 5. Configuration

- `PIE_TRIGGERS_DIR` — backend sidecar directory set by the host.
- `PIE_EXTENSION_TOGGLES_JSON` with `{ "deferred-triggers": false }` disables
  the tool at runtime.

## 6. Verification

Focused coverage includes:

- `extensions/deferred-triggers/test/tool.test.ts` — required message,
  non-aborting registration, default/explicit targets, command safeguard, and
  creator-scoped list/cancel.
- `extensions/deferred-triggers/test/store.test.ts` — append/replay,
  cancellation, legacy note records, and OR-trigger state.
- `extension/test/host/deferred-triggers/deferred-triggers-registry.test.ts` —
  target routing, real-input consumption, timers, retries, self-wake guard,
  and at-most-once delivery.
- `extension/test/host/deferred-triggers/deferred-triggers-store.test.ts` —
  replay, claim artifacts, owner checks, and cancellation ownership.
- `extension/test/backend/transcript/transcript-deferred-trigger.test.ts` —
  wake-prefix presentation after transcript reload.

Run the focused tests with:

```bash
npm run test:file -- \
  extensions/deferred-triggers/test/store.test.ts \
  extensions/deferred-triggers/test/tool.test.ts \
  extension/test/host/deferred-triggers/deferred-triggers-store.test.ts \
  extension/test/host/deferred-triggers/deferred-triggers-registry.test.ts \
  extension/test/backend/transcript/transcript-deferred-trigger.test.ts
```
