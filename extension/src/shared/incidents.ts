import type { NoticeAction } from './error-mapping.js';

export type IncidentSeverity = 'info' | 'warning' | 'error';
export type IncidentCertainty = 'definitive' | 'ambiguous' | 'recovered';
export type IncidentPhase =
  | 'acceptance'
  | 'preflight'
  | 'provider'
  | 'retry'
  | 'tool'
  | 'settlement'
  | 'recovery'
  | 'transport'
  | 'runtime'
  | 'extension';

export interface IncidentRecoveryEligibility {
  retry: boolean;
  restart: boolean;
  showLogs: boolean;
}

/**
 * Backend/host incident authority. Identity fields remain host-side and in
 * diagnostic logs; only the redacted message/detail projection may cross the
 * renderer boundary.
 */
export interface OperationalIncident {
  /** Stable identity of this condition. */
  incidentId: string;
  /** Canonical identity used to collapse reports of the same condition. */
  dedupeKey: string;
  sessionPath: string;
  operationId?: string;
  requestId?: string;
  turnId?: string;
  messageId?: string;
  severity: IncidentSeverity;
  certainty: IncidentCertainty;
  phase: IncidentPhase;
  code: string;
  message: string;
  /** Unredacted diagnostic retained behind the host/log boundary. */
  detail?: string;
  recovery: IncidentRecoveryEligibility;
}

export type OperationalIncidentInput = Omit<OperationalIncident, 'incidentId' | 'dedupeKey' | 'recovery'> & {
  incidentId?: string;
  dedupeKey?: string;
  recovery?: Partial<IncidentRecoveryEligibility>;
};

function primaryIncidentIdentity(input: OperationalIncidentInput): string {
  return input.operationId
    ?? input.requestId
    ?? input.turnId
    ?? input.messageId
    ?? input.sessionPath;
}

/** Construct complete incident data at the producer boundary. */
export function createOperationalIncident(input: OperationalIncidentInput): OperationalIncident {
  const primaryIdentity = primaryIncidentIdentity(input);
  return {
    ...input,
    incidentId: input.incidentId ?? `${input.code}:${primaryIdentity}`,
    dedupeKey: input.dedupeKey ?? `${input.code}:${primaryIdentity}`,
    recovery: {
      retry: input.recovery?.retry === true,
      restart: input.recovery?.restart === true,
      showLogs: input.recovery?.showLogs !== false,
    },
  };
}

/** Recovery projection for the existing notice-action contract. */
export function incidentRecoveryActions(incident: OperationalIncident): NoticeAction[] {
  const actions: NoticeAction[] = [];
  if (incident.recovery.retry) actions.push('retry');
  if (incident.recovery.restart) actions.push('restart-backend');
  if (incident.recovery.showLogs) actions.push('show-logs');
  return actions;
}
