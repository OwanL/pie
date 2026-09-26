import type { NoticeAction } from '../../lib/protocol/webview.js';
import type { OperationalIncident } from '../../../harness/agent-processes/lib/rpc/incident-payload.js';

/** Recovery projection for the existing notice-action contract. */
export function incidentRecoveryActions(incident: OperationalIncident): NoticeAction[] {
  const actions: NoticeAction[] = [];
  if (incident.recovery.retry) actions.push('retry');
  if (incident.recovery.restart) actions.push('restart-backend');
  if (incident.recovery.showLogs) actions.push('show-logs');
  return actions;
}
