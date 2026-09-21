# Agent session control

Pie registers a worker-local `session_control` tool for agent turns. Its
coordinator bridge is typed and identity-fenced; it does not expose a general
worker RPC tunnel.

## Actions

- `list` returns bounded session summaries and `scope: "current-extension-host"`.
  `busy` reflects the owning runtime's active request.
- `create` uses the existing `session.create` operation and returns a cold
  session. Supplying `cwd` is optional. A later `message` promotes the session
  through the normal isolated-runtime path.
- `read` uses the existing transcript paging operation. The first request uses
  `direction: "latest"`; subsequent requests pass the returned
  `cursor: { start, end }` with `direction: "older"` or `"newer"`. `limit` is
  bounded to 1--64 rows.
- `message` uses ordinary `message.send` semantics. Idle targets wake through
  the normal runtime path; busy targets retain Pie's existing queued-send
  behavior.
- `close` uses `session.lifecycleClose`. It is reversible by default. Passing
  `delete: true` records the privacy decision, acknowledges the lifecycle
  close, then runs the existing `session.forget` cleanup after the response;
  it does not introduce a separate stop/archive lifecycle.

Session paths default to the worker's current session. Explicit targets must
be present in the local coordinator catalog or be that current session. This
first slice intentionally does not federate across extension-host windows.
The tool result and transcript projection are bounded before crossing worker
IPC. Cancellation rejects the worker request without unsafely rolling back an
already-admitted coordinator operation; its late result is dropped by request
identity.
