import assert from "node:assert/strict";
import test from "node:test";

import { getCapacityAvailableModelIds } from "../src/provider-capacity.js";

test("capacity model ids exclude only ids whose every enabled provider is saturated", () => {
  const result = getCapacityAvailableModelIds(
    [
      { id: "shared", provider: "busy" },
      { id: "shared", provider: "open" },
      { id: "busy-only", provider: "busy" },
      { id: "unknown", provider: "ungated" },
      { id: "disabled-only", provider: "disabled" },
    ],
    new Set(["disabled"]),
    {
      busy: { immediatelyClaimable: false },
      open: { immediatelyClaimable: true },
    },
  );

  assert.deepEqual(result, new Set(["shared", "unknown"]));
});

test("capacity model ids fail open when no provider has a live snapshot", () => {
  const result = getCapacityAvailableModelIds(
    [{ id: "model-a", provider: "unknown" }],
    new Set(),
    {},
  );

  assert.equal(result, undefined);
});
