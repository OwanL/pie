/**
 * Explicit authorization for the storage cutoff.
 *
 * The cutoff closes every Pie-managed session and starts their expiry
 * deadlines, which is irreversible for those sessions, so it is gated on an
 * evidence value rather than on a boolean someone could pass by accident. The
 * `-v1` suffix is the consent version: a future change to what the cutoff
 * does must not silently inherit this authorization.
 *
 * Single source of truth shared by the layers that gate on it — the host
 * launch channel that decides the backend's session root and advertises the
 * cutoff capability, the session service, the backend coordinator, and the
 * promoted worker runtime. Consumers read
 * `process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV]` and compare it to
 * `STORAGE_CUTOFF_AUTHORIZATION_VALUE`; do not redeclare the name or value.
 */
export const STORAGE_CUTOFF_AUTHORIZATION_ENV = 'PIE_STORAGE_CUTOFF_AUTHORIZATION' as const;
export const STORAGE_CUTOFF_AUTHORIZATION_VALUE = 'p7b-authorized-v1' as const;
