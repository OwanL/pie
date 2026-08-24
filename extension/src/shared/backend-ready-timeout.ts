/**
 * Time the host waits for the backend to become ready after spawn, shared
 * between:
 *  - `BackendClient.start()` (`READY_TIMEOUT_MS`) — rejects the spawn promise
 *    with "Timed out waiting for the pie backend to become ready."
 *  - the reducer's `StartBackendReadyWatchdog` effect — drops queued sends
 *    and shows "Backend did not become ready within Ns."
 *  - a first `message.send` to a cold session — allows the isolated worker to
 *    load the same SDK/services before acknowledging the queued prompt.
 *
 * Sized to absorb a cold SDK load. The backend's `start.loadSdk` step
 * dynamically imports the upstream `@earendil-works/pi-coding-agent` bundle,
 * which on Windows routinely takes ~30s on a first/cold import. After proxy
 * removal, the backend also installs the host-side ProviderGate and performs
 * auth setup, bringing cold-start total to ~59-66s (observed in pie-logs:
 * spawn at 10:13:24, ready at 10:14:30 = 66s). The previous 60s budget
 * rejected a healthy backend *just* as it finished coming up — orphaning it
 * and leaving the UI stuck at "loading sessions" since
 * `listAndOpenFirstSession()` was never reached. 120s gives comfortable
 * headroom while still surfacing genuinely hung backends.
 *
 * Cold session promotion has the same failure mode: a 60s host deadline can
 * roll back a prompt even though the worker becomes ready and executes it a
 * few seconds later. Keep this single source of truth; do not redeclare the
 * timeout elsewhere.
 */
export const BACKEND_READY_TIMEOUT_MS = 120_000;
