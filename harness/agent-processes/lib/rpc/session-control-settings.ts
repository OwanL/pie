/** Typed coordinator→host settings bridge used by session_control inheritance
 * (stage 3 of session-control refinement). This deliberately carries only the
 * two host-owned execution preferences, not a general preferences RPC. */
export const SESSION_CONTROL_SETTINGS_REQUEST_EVENT = 'session.settings.requested';
export const SESSION_CONTROL_SETTINGS_ACK_METHOD = 'session.settingsAcknowledgement';
export const SESSION_CONTROL_SETTINGS_MAX_CHOICES = 128;

const REQUEST_ID_MAX_BYTES = 512;
const SESSION_PATH_MAX_BYTES = 16 * 1024;
const PROVIDER_MAX_BYTES = 256;
const ERROR_MAX_BYTES = 4 * 1024;

export interface SessionControlExecutionSettings {
  /** Effective autonomous setting for the addressed root session. */
  autonomousMode: boolean;
  /** Effective choices for the configured subagent-provider toggle surface. */
  subagentProviderChoices: Record<string, boolean>;
}

/** Explicit overrides accepted by the narrow `apply` request. */
export type SessionControlExecutionSettingsPatch = Partial<SessionControlExecutionSettings>;

export interface SessionControlSettingsRequest {
  requestId: string;
  sessionPath: string;
  action: 'capture' | 'apply';
  /** Required for `apply`; omitted for `capture`. */
  settings?: SessionControlExecutionSettingsPatch;
}

export interface SessionControlSettingsAcknowledgement {
  requestId: string;
  sessionPath: string;
  action: 'capture' | 'apply';
  outcome: 'succeeded' | 'failed' | 'unknown';
  settings?: SessionControlExecutionSettings;
  /** Runtime application may be pending when no backend is ready yet. */
  application?: 'applied' | 'pending' | 'unknown';
  error?: string;
}

function fail(method: string, detail: string): never {
  throw new TypeError(`Invalid params for ${method}: ${detail}`);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validateChoices(value: unknown, label: string): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(SESSION_CONTROL_SETTINGS_REQUEST_EVENT, `${label} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SESSION_CONTROL_SETTINGS_MAX_CHOICES) {
    fail(SESSION_CONTROL_SETTINGS_REQUEST_EVENT, `${label} must contain at most ${SESSION_CONTROL_SETTINGS_MAX_CHOICES} choices`);
  }
  const choices: Record<string, boolean> = {};
  for (const [provider, enabled] of entries) {
    if (!isBoundedString(provider, PROVIDER_MAX_BYTES) || typeof enabled !== 'boolean') {
      fail(SESSION_CONTROL_SETTINGS_REQUEST_EVENT, `${label} must map bounded provider names to booleans`);
    }
    choices[provider] = enabled;
  }
  return choices;
}

/** Validate a coordinator→host settings request before it enters the reducer. */
export function validateSessionControlSettingsRequest(value: unknown): SessionControlSettingsRequest {
  const method = SESSION_CONTROL_SETTINGS_REQUEST_EVENT;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(method, 'expected an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['requestId', 'sessionPath', 'action', 'settings'].includes(key))) {
    fail(method, 'request contains an unsupported field');
  }
  if (!isBoundedString(raw['requestId'], REQUEST_ID_MAX_BYTES)) fail(method, 'requestId must be a bounded non-empty string');
  if (!isBoundedString(raw['sessionPath'], SESSION_PATH_MAX_BYTES)) fail(method, 'sessionPath must be a bounded non-empty string');
  if (raw['action'] !== 'capture' && raw['action'] !== 'apply') fail(method, 'action must be capture or apply');
  let settings: SessionControlExecutionSettingsPatch | undefined;
  if (raw['settings'] !== undefined) {
    if (!raw['settings'] || typeof raw['settings'] !== 'object' || Array.isArray(raw['settings'])) {
      fail(method, 'settings must be an object when provided');
    }
    const rawSettings = raw['settings'] as Record<string, unknown>;
    for (const key of Object.keys(rawSettings)) {
      if (key !== 'autonomousMode' && key !== 'subagentProviderChoices') {
        fail(method, `settings.${key} is not supported`);
      }
    }
    settings = {
      ...(rawSettings['autonomousMode'] !== undefined
        ? typeof rawSettings['autonomousMode'] === 'boolean'
          ? { autonomousMode: rawSettings['autonomousMode'] }
          : fail(method, 'settings.autonomousMode must be a boolean')
        : {}),
      ...(rawSettings['subagentProviderChoices'] !== undefined
        ? { subagentProviderChoices: validateChoices(rawSettings['subagentProviderChoices'], 'settings.subagentProviderChoices') }
        : {}),
    };
  }
  if (raw['action'] === 'capture' && settings !== undefined) fail(method, 'capture does not accept settings');
  if (raw['action'] === 'apply' && (!settings || Object.keys(settings).length === 0)) {
    fail(method, 'apply requires at least one supported setting');
  }
  return {
    requestId: raw['requestId'] as string,
    sessionPath: raw['sessionPath'] as string,
    action: raw['action'] as 'capture' | 'apply',
    ...(settings ? { settings } : {}),
  };
}

/** Validate the host→coordinator correlated acknowledgement payload. */
export function isSessionControlSettingsRequest(value: unknown): value is SessionControlSettingsRequest {
  try {
    validateSessionControlSettingsRequest(value);
    return true;
  } catch {
    return false;
  }
}

export function validateSessionControlSettingsAcknowledgement(
  value: unknown,
): SessionControlSettingsAcknowledgement {
  const method = SESSION_CONTROL_SETTINGS_ACK_METHOD;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(method, 'expected an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['requestId', 'sessionPath', 'action', 'outcome', 'settings', 'application', 'error'].includes(key))) {
    fail(method, 'acknowledgement contains an unsupported field');
  }
  if (!isBoundedString(raw['requestId'], REQUEST_ID_MAX_BYTES)) fail(method, 'requestId must be a bounded non-empty string');
  if (!isBoundedString(raw['sessionPath'], SESSION_PATH_MAX_BYTES)) fail(method, 'sessionPath must be a bounded non-empty string');
  if (raw['action'] !== 'capture' && raw['action'] !== 'apply') fail(method, 'action must be capture or apply');
  if (raw['outcome'] !== 'succeeded' && raw['outcome'] !== 'failed' && raw['outcome'] !== 'unknown') {
    fail(method, 'outcome must be succeeded, failed, or unknown');
  }
  let settings: SessionControlExecutionSettings | undefined;
  if (raw['settings'] !== undefined) {
    if (!raw['settings'] || typeof raw['settings'] !== 'object' || Array.isArray(raw['settings'])) {
      fail(method, 'settings must be an object when provided');
    }
    const candidate = raw['settings'] as Record<string, unknown>;
    if (typeof candidate['autonomousMode'] !== 'boolean') fail(method, 'settings.autonomousMode must be a boolean');
    settings = {
      autonomousMode: candidate['autonomousMode'],
      subagentProviderChoices: validateChoices(candidate['subagentProviderChoices'], 'settings.subagentProviderChoices'),
    };
  }
  if (raw['application'] !== undefined
    && raw['application'] !== 'applied' && raw['application'] !== 'pending' && raw['application'] !== 'unknown') {
    fail(method, 'application must be applied, pending, or unknown');
  }
  if (raw['error'] !== undefined && !isBoundedString(raw['error'], ERROR_MAX_BYTES)) {
    fail(method, 'error must be a bounded non-empty string');
  }
  return {
    requestId: raw['requestId'] as string,
    sessionPath: raw['sessionPath'] as string,
    action: raw['action'] as 'capture' | 'apply',
    outcome: raw['outcome'] as 'succeeded' | 'failed' | 'unknown',
    ...(settings ? { settings } : {}),
    ...(raw['application'] !== undefined ? { application: raw['application'] as 'applied' | 'pending' | 'unknown' } : {}),
    ...(raw['error'] !== undefined ? { error: raw['error'] as string } : {}),
  };
}
