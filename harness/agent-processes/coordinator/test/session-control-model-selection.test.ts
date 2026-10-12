import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectSessionControlModel,
  parseBucketConfig,
  type SessionControlModelSelectionInput,
} from "../session-control-model-selection.js";
import { resetFairSelectionBags } from "../../../tools/subagent/bucket-selector.js";

function input(overrides: Partial<SessionControlModelSelectionInput> = {}): SessionControlModelSelectionInput {
  return {
    bucket: "frontier",
    assignments: parseBucketConfig(JSON.stringify({ frontier: [{ model: "a/shared", thinkingLevel: "high" }] })),
    callerModel: { provider: "b", id: "shared" },
    callerThinkingLevel: "low",
    subagentProviderChoices: {}, providerToggles: {},
    availableModels: [{ provider: "a", id: "shared", reasoning: true }, { provider: "b", id: "shared", reasoning: true }],
    ...overrides,
  };
}

test("exact provider identities and explicit reasoning survive duplicate ids", () => {
  const result = selectSessionControlModel(input());
  assert.deepEqual(result.model, { provider: "a", id: "shared" });
  assert.equal(result.reasoning, "high");
  assert.equal(result.fallback, false);
});

test("global and session provider filters never substitute the duplicate id", () => {
  for (const overrides of [{ providerToggles: { a: false } }, { subagentProviderChoices: { a: false } }]) {
    const result = selectSessionControlModel(input(overrides));
    assert.deepEqual(result.model, { provider: "b", id: "shared" });
    assert.equal(result.fallback, true);
    assert.equal(result.reasoning, "low");
  }
});

test("bare ids prefer caller provider; ambiguous ids without caller provider are excluded", () => {
  const assignments = parseBucketConfig('{"frontier":[{"model":"shared","thinkingLevel":"high"}]}');
  assert.equal(selectSessionControlModel(input({ assignments })).model.provider, "b");
  assert.throws(() => selectSessionControlModel(input({ assignments, callerModel: { provider: "c", id: "shared" } })), /allowed=false/);
  assert.equal(selectSessionControlModel(input({ assignments, availableModels: [{ provider: "a", id: "shared", reasoning: true }] })).model.provider, "a");
});

test("unsupported explicit thinking is excluded, never clamped", () => {
  for (const declaration of [{ reasoning: false }, { reasoning: true, thinkingLevelMap: { high: null } }]) {
    const result = selectSessionControlModel(input({ availableModels: [
      { provider: "a", id: "shared", ...declaration },
      { provider: "b", id: "shared", reasoning: true },
    ] }));
    assert.equal(result.fallback, true);
    assert.equal(result.reasoning, "low");
  }
});

test("ineligible or disabled caller cannot be used on exhaustion", () => {
  const assignments = parseBucketConfig(undefined);
  assert.throws(() => selectSessionControlModel(input({ assignments, isEligible: () => false })), /No eligible.*allowed=false/);
  assert.throws(() => selectSessionControlModel(input({ assignments, providerToggles: { b: false } })), /allowed=false/);
  assert.throws(() => selectSessionControlModel(input({ assignments, callerThinkingLevel: "max" })), /allowed=false/);
});

test("empty assignments inherit allowed caller reasoning and report empty pool", () => {
  const result = selectSessionControlModel(input({ assignments: parseBucketConfig(undefined) }));
  assert.equal(result.fallback, true);
  assert.deepEqual(result.pool, []);
  assert.equal(result.reasoning, "low");
});

test("descends tiers without inheriting caller reasoning or searching upward", () => {
  const assignments = parseBucketConfig('{"medium":[{"model":"a/shared","thinkingLevel":"off"}]}');
  const result = selectSessionControlModel(input({ assignments }));
  assert.equal(result.requestedBucket, "frontier");
  assert.equal(result.effectiveBucket, "medium");
  assert.equal(result.reasoning, "off");
  assert.equal(result.fallback, false);
  assert.equal(selectSessionControlModel(input({ assignments, bucket: "small" })).fallback, true);
});

test("fair draws stay balanced across the eligible pool", () => {
  resetFairSelectionBags();
  const assignments = parseBucketConfig('{"frontier":[{"model":"a/shared","thinkingLevel":"high"},{"model":"b/shared","thinkingLevel":"low"}]}');
  const counts: Record<string, number> = { a: 0, b: 0 };
  for (let i = 0; i < 100; i++) counts[selectSessionControlModel(input({ assignments })).model.provider]++;
  assert.deepEqual(counts, { a: 50, b: 50 });
});
