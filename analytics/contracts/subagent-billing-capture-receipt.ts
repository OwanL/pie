/** Producer-owned evidence that a subagent terminal attempt was offered to canonical analytics capture. */
export interface SubagentBillingCaptureReceipt {
  factStatus: 'disabled' | 'submitted' | 'rejected';
  generationId: string;
  stableOriginId: string;
  executionId: string;
  attemptId: string;
  terminalDetailPayloadId: string;
  lastSubmittedSequence: number;
  lastAcknowledgedSequence?: number | string;
  terminalDetailComplete: boolean;
}
