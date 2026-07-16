const INFRASTRUCTURE_TERMINAL_STATES = new Set([
  "malformed_event",
  "process_error",
  "provider_failure",
  "provider_policy_violation",
]);

/**
 * Classify trial execution separately from score eligibility.
 *
 * Policy, timeout, and deterministic-check failures are benchmark outcomes:
 * excluding them would bias comparisons toward successful agents.
 * Only failures that make the measurement itself untrustworthy are censored.
 */
export function classifyTrialOutcome({
  processClassification,
  targetPolicyViolations = [],
  providerPolicyViolation = false,
  assistantError,
  startupSnapshot,
  checks = [],
  privateCheck,
}) {
  const checksPassed = checks.every(check => check.passed);
  const effectiveProviderFailure = processClassification !== "complete" && Boolean(assistantError);

  const terminalState = providerPolicyViolation
    ? "provider_policy_violation"
    : processClassification === "malformed_event"
      ? "malformed_event"
      : targetPolicyViolations.length
        ? "resource_policy_violation"
        : effectiveProviderFailure
          ? "provider_failure"
          : processClassification;

  const infrastructureReasons = new Set();
  if (!startupSnapshot) infrastructureReasons.add("missing_startup_snapshot");
  if (providerPolicyViolation) infrastructureReasons.add("provider_policy_violation");
  if (processClassification === "malformed_event" || processClassification === "process_error") infrastructureReasons.add(processClassification);
  if (effectiveProviderFailure) infrastructureReasons.add("provider_failure");
  if (INFRASTRUCTURE_TERMINAL_STATES.has(terminalState)) infrastructureReasons.add(terminalState);
  if (privateCheck?.artifactLimit) infrastructureReasons.add("scorer_artifact_limit");

  const outcomeFlags = [];
  if (assistantError && !effectiveProviderFailure) outcomeFlags.push("trailing_provider_error_after_completion");
  if (privateCheck?.timedOut) outcomeFlags.push("scorer_timeout");

  const measuredScore = privateCheck?.measurement?.score;
  const primaryScore = Number.isFinite(measuredScore) ? measuredScore : 0;
  const scoreEligibility = infrastructureReasons.size ? "diagnostic-only" : "primary";
  const trialPassed = terminalState === "complete" && checksPassed && targetPolicyViolations.length === 0;

  return {
    terminalState,
    checksPassed,
    trialPassed,
    scoreEligibility,
    primaryScore,
    infrastructureReasons: [...infrastructureReasons],
    outcomeFlags,
  };
}
