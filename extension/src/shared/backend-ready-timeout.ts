/**
 * Time the host waits for the backend to become ready after spawn, shared
 * between:
 *  - `BackendClient.start()` (`READY_TIMEOUT_MS`) — rejects the spawn promise
 *    with "Timed out waiting for the pie backend to become ready."
 *  - the reducer's `StartBackendReadyWatchdog` effect — drops queued sends
 *    and shows "Backend did not become ready within Ns."
 *
 * Sized to absorb a cold SDK load. The backend's `start.loadSdk` step
 * dynamically imports the upstream `@earendil-works/pi-coding-agent` bundle,
 * which on Windows routinely takes ~30s on a first/cold import (observed
 * 30,033ms in pie-logs, finishing ~270ms AFTER a 30s budget). A 30s budget
 * rejects the backend *just* as it finishes coming up — orphaning a healthy
 * backend. 60s gives comfortable headroom while still surfacing genuinely
 * hung backends.
 *
 * Keep this single source of truth; do not redeclare the timeout elsewhere.
 */
export const BACKEND_READY_TIMEOUT_MS = 60_000;