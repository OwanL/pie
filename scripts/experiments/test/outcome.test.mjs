import test from "node:test";
import assert from "node:assert/strict";
import { classifyTrialOutcome } from "../lib/outcome.mjs";

const startupSnapshot = { model: "umans/umans-glm-5.2" };
const passedCheck = { passed: true, measurement: { valid: true, score: 0.8 } };

function classify(overrides = {}) {
  const privateCheck = overrides.privateCheck ?? passedCheck;
  return classifyTrialOutcome({
    processClassification: "complete",
    startupSnapshot,
    checks: [privateCheck],
    privateCheck,
    ...overrides,
  });
}

test("a clean completed trial is a passing primary measurement", () => {
  const result = classify();
  assert.equal(result.terminalState, "complete");
  assert.equal(result.trialPassed, true);
  assert.equal(result.scoreEligibility, "primary");
  assert.equal(result.primaryScore, 0.8);
});

test("policy failures remain primary benchmark outcomes", () => {
  const policy = classify({ targetPolicyViolations: [{ type: "unrelated_changes" }] });
  assert.equal(policy.terminalState, "resource_policy_violation");
  assert.equal(policy.trialPassed, false);
  assert.equal(policy.scoreEligibility, "primary");
  assert.equal(policy.primaryScore, 0.8);
});

test("a bounded scorer timeout is a primary zero-score task failure", () => {
  const privateCheck = { passed: false, timedOut: true };
  const result = classify({ checks: [privateCheck], privateCheck });
  assert.equal(result.scoreEligibility, "primary");
  assert.equal(result.primaryScore, 0);
  assert.deepEqual(result.outcomeFlags, ["scorer_timeout"]);
});

test("a trailing provider error cannot censor completed checked work", () => {
  const result = classify({ assistantError: { stopReason: "error" } });
  assert.equal(result.terminalState, "complete");
  assert.equal(result.scoreEligibility, "primary");
  assert.deepEqual(result.outcomeFlags, ["trailing_provider_error_after_completion"]);
});

test("measurement-integrity failures remain diagnostic-only", () => {
  for (const input of [
    { processClassification: "malformed_event" },
    { processClassification: "cleanup_failure" },
    { processClassification: "target_failure", assistantError: { stopReason: "error" } },
    { processClassification: "target_failure", assistantError: { stopReason: "error" }, targetPolicyViolations: [{ type: "unrelated_changes" }] },
    { providerPolicyViolation: true },
    { startupSnapshot: undefined },
  ]) {
    const result = classify(input);
    assert.equal(result.scoreEligibility, "diagnostic-only");
    assert.ok(result.infrastructureReasons.length > 0);
  }
});
