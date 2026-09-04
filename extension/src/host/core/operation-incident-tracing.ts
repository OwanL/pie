import type { LivePipelineTraceEvent } from '../../shared/live-pipeline-trace.js';
import type { Event } from './events.js';
import type { ArchState } from './reducer.js';
import type { SessionOperation } from './operation-types.js';

interface OperationTraceSnapshot {
  phase: SessionOperation['phase'];
  acceptance: SessionOperation['acceptance'];
  commit: SessionOperation['commit'];
  terminalOutcome?: NonNullable<SessionOperation['terminal']>['outcome'];
  terminalReason?: NonNullable<SessionOperation['terminal']>['reason'];
}

function snapshot(operation: SessionOperation): OperationTraceSnapshot {
  return {
    phase: operation.phase,
    acceptance: operation.acceptance,
    commit: operation.commit,
    terminalOutcome: operation.terminal?.outcome,
    terminalReason: operation.terminal?.reason,
  };
}

function changed(before: OperationTraceSnapshot | undefined, after: OperationTraceSnapshot): boolean {
  return before === undefined
    || before.phase !== after.phase
    || before.acceptance !== after.acceptance
    || before.commit !== after.commit
    || before.terminalOutcome !== after.terminalOutcome
    || before.terminalReason !== after.terminalReason;
}

/**
 * Build metadata-only diagnostic records for semantic lifecycle changes.
 * Raw semantic IDs exist only in the transient `identifiers` map and are HMACed
 * by `createLivePipelineTraceRecord`; request/correlation/worker IDs, incident
 * messages/details, prompts, and credentials are deliberately not accepted.
 */
export function operationAndIncidentTraceEvents(
  before: ArchState,
  after: ArchState,
  event: Event,
): LivePipelineTraceEvent[] {
  const traces: LivePipelineTraceEvent[] = [];
  for (const [operationId, operation] of Object.entries(after.operations)) {
    const prior = before.operations[operationId];
    const previous = prior ? snapshot(prior) : undefined;
    const current = snapshot(operation);
    if (!changed(previous, current)) continue;
    traces.push({
      process: 'host',
      processRole: 'host',
      stage: 'host.operation.transition',
      kind: operation.terminal?.outcome === 'settled'
        ? 'success'
        : operation.terminal?.outcome === 'failed'
          ? 'failure'
          : 'transition',
      identifiers: {
        operation: operationId,
        session: operation.session.resolvedPath ?? operation.session.pendingPath,
      },
      operationKind: operation.kind,
      ...(previous ? { previousOperationPhase: previous.phase } : {}),
      operationPhase: operation.phase,
      operationAcceptance: operation.acceptance,
      operationCommit: operation.commit,
      ...(operation.terminal ? {
        operationTerminalOutcome: operation.terminal.outcome,
        operationTerminalReason: operation.terminal.reason,
      } : {}),
    });
  }

  if (event.kind === 'IncidentReported' && before.settings.latestIncident !== after.settings.latestIncident) {
    const incident = event.incident;
    traces.push({
      process: 'host',
      processRole: 'host',
      stage: 'host.incident.reported',
      kind: 'observation',
      identifiers: {
        incident: incident.incidentId,
        session: incident.sessionPath,
        ...(incident.operationId ? { operation: incident.operationId } : {}),
      },
      incidentSeverity: incident.severity,
      incidentCertainty: incident.certainty,
      incidentPhase: incident.phase,
    });
  }
  return traces;
}
