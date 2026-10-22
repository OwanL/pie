import test from "node:test";
import assert from "node:assert/strict";
import { selectModel } from "../bucket-selector.js";
import { parseSessionBucketToggles } from "../bucket-toggles.js";
import { resolveModel, type SelectionContext } from "../selection.js";
import { SUBAGENT_BUCKET_TIERS as tiers, type SubagentBucketChoices } from "../../../../lib/subagent-bucket-policy.js";

const assignments = { small: [{ model: "s", thinkingLevel: "off" as const }], medium: [{ model: "m", thinkingLevel: "off" as const }], frontier: [{ model: "f", thinkingLevel: "off" as const }] };
for (let mask = 1; mask < 8; mask++) {
 const choices = Object.fromEntries(tiers.map((tier, index) => [tier, !!(mask & (1 << index))])) as SubagentBucketChoices;
 for (const [index, requested] of tiers.entries()) test(`choices ${mask}, request ${requested}`, () => {
  const expected = [requested, ...tiers.slice(0, index).reverse(), ...tiers.slice(index + 1)].find((tier) => choices[tier]);
  const result = selectModel(requested, assignments, [], undefined, undefined, "parent", "off", undefined, undefined, undefined, choices);
  assert.equal(result.bucket, expected);
  assert.equal(result.fallback, false);
 });
}

test("session parsing normalizes Windows paths and rejects invalid/all-off values", () => {
 const choices = { small: false, medium: true, frontier: false };
 assert.deepEqual(parseSessionBucketToggles(JSON.stringify({ "C:\\Chats\\Root": choices }), "c:/chats/root"), choices);
 for (const raw of [undefined, "bad", JSON.stringify({ root: { small: false, medium: false, frontier: false } })]) {
  assert.deepEqual(parseSessionBucketToggles(raw, "root"), { small: true, medium: true, frontier: true });
 }
});

test("empty buckets skip disabled tiers without weakening requirement/provider filters", () => {
 const choices = { small: true, medium: false, frontier: true };
 const result = selectModel("frontier", { ...assignments, frontier: [] }, [], new Set(["s", "m"]), undefined, "parent", "off", undefined, new Set(["m"]), undefined, choices);
 assert.equal(result.fallback, true);
 assert.equal(result.modelId, "");
});

test("nested policy intersects choices; an empty intersection inherits caller", async () => {
 const context: SelectionContext = {
  modelConfig: [], disabledProviders: new Set(), allowedModelIds: undefined,
  bucketAssignments: assignments, alwaysParentModel: false,
  nestedAllowedBuckets: { small: false, medium: true, frontier: false },
  subagentBucketChoices: { small: false, medium: false, frontier: true },
 };
 const agent = { name: "worker" } as Parameters<typeof resolveModel>[0];
 const empty = await resolveModel(agent, context, "parent", "small", undefined, 1);
 assert.equal(empty.modelOverride, "parent");
 assert.equal(empty.selection.fallback, true);
 context.nestedAllowedBuckets.frontier = true;
 const permitted = await resolveModel(agent, context, "parent", "small", undefined, 1);
 assert.equal(permitted.bucket, "frontier");
 assert.equal(permitted.modelOverride, "f");
});
