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

  assert.deepEqual(result, new Set([
    "open/shared",
    "ungated/unknown",
    "shared",
    "unknown",
  ]));
});

test("capacity routing distinguishes saturated qualified duplicates", () => {
  const result = getCapacityAvailableModelIds(
    [
      { id: "gpt-5.4", provider: "github-copilot" },
      { id: "gpt-5.4", provider: "openai-codex" },
    ],
    new Set(),
    {
      "github-copilot": { immediatelyClaimable: false },
      "openai-codex": { immediatelyClaimable: true },
    },
  );

  assert.deepEqual(result, new Set([
    "openai-codex/gpt-5.4",
    "gpt-5.4",
  ]));
});

test("capacity model ids fail open when no provider has a live snapshot", () => {
  const result = getCapacityAvailableModelIds(
    [{ id: "model-a", provider: "unknown" }],
    new Set(),
    {},
  );

  assert.equal(result, undefined);
});
