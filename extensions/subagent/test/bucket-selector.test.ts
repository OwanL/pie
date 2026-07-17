/**
 * Tests for the bucket-selector module.
 *
 * Covers: selectModel, nearestSupportedThinking (re-implemented for
 * direct testing since it's not exported), loadModelConfig,
 * parseProviderToggles, getDisabledProviders, and
 * getAllowedModelIdsForProviders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  selectModel,
  loadModelConfig,
  parseProviderToggles,
  parseSessionProviderToggles,
  resolveSubagentProviderToggles,
  getDisabledProviders,
  getAllowedModelIdsForProviders,
  nearestSupportedThinking,
  parseBucketConfig,
  readBucketAssignments,
  PROVIDER_TOGGLES_ENV,
  SUBAGENT_PROVIDER_DEFAULTS_ENV,
  SUBAGENT_PROVIDER_TOGGLES_ENV,
  SUBAGENT_BUCKETS_ENV,
} from "../bucket-selector.js";
import type { ThinkingLevel, ModelProviderRef, BucketAssignments, SimpleModelConfig } from "../bucket-selector.js";

// ============================================================
// nearestSupportedThinking
// ============================================================

describe("nearestSupportedThinking", () => {
  it("returns the requested level if supported", () => {
    assert.equal(nearestSupportedThinking("high", ["low", "high", "xhigh"]), "high");
    assert.equal(nearestSupportedThinking("minimal", ["minimal"]), "minimal");
    assert.equal(nearestSupportedThinking("medium", ["low", "medium", "high"]), "medium");
  });

  it("returns undefined when no levels are supported at all", () => {
    assert.equal(nearestSupportedThinking("medium", []), undefined);
    assert.equal(nearestSupportedThinking("high", []), undefined);
  });

  it("walks to adjacent levels when exact level not found", () => {
    // Requested "high" but only "medium" supported → one step lower
    assert.equal(nearestSupportedThinking("high", ["medium"]), "medium");
    // Requested "high" but only "xhigh" supported → one step higher
    assert.equal(nearestSupportedThinking("high", ["xhigh"]), "xhigh");
    // Requested "low" but only "minimal" supported → one step lower
    assert.equal(nearestSupportedThinking("low", ["minimal"]), "minimal");
  });

  it("prefers lower over higher at same offset", () => {
    // Both medium and xhigh are 1 step from high → medium (lower) wins
    assert.equal(nearestSupportedThinking("high", ["medium", "xhigh"]), "medium");
    // Both low and high are 1 step from medium → low (lower) wins
    assert.equal(nearestSupportedThinking("medium", ["low", "high"]), "low");
  });

  it("walks outward from medium (center)", () => {
    // From "medium": offset 1 → low, high; offset 2 → minimal, xhigh
    assert.equal(nearestSupportedThinking("medium", ["low"]), "low");
    assert.equal(nearestSupportedThinking("medium", ["high"]), "high");
    assert.equal(nearestSupportedThinking("medium", ["minimal"]), "minimal");
    assert.equal(nearestSupportedThinking("medium", ["xhigh"]), "xhigh");
    // When both minimal and xhigh available (offset 2), minimal (lower) wins
    assert.equal(nearestSupportedThinking("medium", ["minimal", "xhigh"]), "minimal");
  });

  it("walks outward from high (right-of-center)", () => {
    // From "high": offset 1 → medium, xhigh; offset 2 → low; offset 3 → minimal
    assert.equal(nearestSupportedThinking("high", ["medium"]), "medium");
    assert.equal(nearestSupportedThinking("high", ["xhigh"]), "xhigh");
    assert.equal(nearestSupportedThinking("high", ["low"]), "low");
    assert.equal(nearestSupportedThinking("high", ["minimal"]), "minimal");
  });

  it("walks outward from minimal (left edge)", () => {
    // From "minimal": offset 1 → low; offset 2 → medium; offset 3 → high; offset 4 → xhigh
    assert.equal(nearestSupportedThinking("minimal", ["low"]), "low");
    assert.equal(nearestSupportedThinking("minimal", ["medium"]), "medium");
    assert.equal(nearestSupportedThinking("minimal", ["high"]), "high");
    assert.equal(nearestSupportedThinking("minimal", ["xhigh"]), "xhigh");
  });

  it("walks outward from xhigh (right edge)", () => {
    // From "xhigh": offset 1 → high; offset 2 → medium; offset 3 → low; offset 4 → minimal
    assert.equal(nearestSupportedThinking("xhigh", ["high"]), "high");
    assert.equal(nearestSupportedThinking("xhigh", ["medium"]), "medium");
    assert.equal(nearestSupportedThinking("xhigh", ["low"]), "low");
    assert.equal(nearestSupportedThinking("xhigh", ["minimal"]), "minimal");
  });

  it("returns undefined when no supported level exists in walk range", () => {
    // All levels are in THINKING_ORDER so this can't happen with valid levels,
    // but if supported is empty we already return undefined
    assert.equal(nearestSupportedThinking("medium", []), undefined);
  });
});

// ============================================================
// selectModel
// ============================================================

describe("selectModel", () => {
  const EMPTY_ASSIGNMENTS: BucketAssignments = { small: [], medium: [], frontier: [] };
  const ACTIVE_MODEL = "active-model-v1";

  function makeConfig(models: { id: string; thinking?: ThinkingLevel[] }[]): SimpleModelConfig[] {
    return models.map((m) => ({
      id: m.id,
      eligible: true,
      thinking: m.thinking ?? ["minimal", "low", "medium", "high", "xhigh"],
      disabled_reason: null,
      cost: 1,
    }));
  }

  it("returns a model from the bucket when assignments are populated", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["model-a", "model-b", "model-c"],
      frontier: [],
    };
    const config = makeConfig([
      { id: "model-a" },
      { id: "model-b" },
      { id: "model-c" },
    ]);

    // Run multiple times to verify we always get a valid model from the pool
    for (let i = 0; i < 20; i++) {
      const result = selectModel("medium", undefined, assignments, config, undefined, undefined, ACTIVE_MODEL);
      assert.equal(result.fallback, false);
      assert.equal(result.bucket, "medium");
      assert.ok(["model-a", "model-b", "model-c"].includes(result.modelId));
      assert.ok(result.pool.includes(result.modelId));
    }
  });

  it("returns fallback (active model) when bucket is empty", () => {
    const result = selectModel("medium", undefined, EMPTY_ASSIGNMENTS, [], undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, ACTIVE_MODEL);
    assert.equal(result.bucket, "medium");
    assert.deepEqual(result.pool, []);
  });

  it("returns fallback when all models in bucket are excluded via excludeModels", () => {
    const assignments: BucketAssignments = {
      small: ["model-x"],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-x" }]);
    const exclude = new Set(["model-x"]);

    const result = selectModel("small", undefined, assignments, config, undefined, exclude, ACTIVE_MODEL);
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, ACTIVE_MODEL);
    assert.deepEqual(result.pool, []);
  });

  it("filters by thinkingLevel — excludes models that don't support it", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["model-low-only", "model-all"],
      frontier: [],
    };
    const config = makeConfig([
      { id: "model-low-only", thinking: ["low"] },
      { id: "model-all", thinking: ["low", "medium", "high"] },
    ]);

    // Requesting "high" — only model-all supports it
    const result = selectModel("medium", "high", assignments, config, undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-all");
    assert.deepEqual(result.pool, ["model-all"]);
  });

  it("falls back to nearest supported thinking level when no models support the requested level", () => {
    const assignments: BucketAssignments = {
      small: ["model-mid"],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([
      { id: "model-mid", thinking: ["low", "medium"] },
    ]);

    // Requesting "xhigh" but model only supports low/medium → should relax to "medium" (nearest to xhigh via walk)
    // Walk from xhigh: offset 1→high (no), offset 2→medium (yes!)
    const result = selectModel("small", "xhigh", assignments, config, undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-mid");
    // The relaxed thinkingLevel should be "medium" (nearest supported to "xhigh")
    assert.equal(result.thinkingLevel, "medium");
  });

  it("uses unfiltered pool when relaxation fails (no supported thinking levels)", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["restricted-model"],
      frontier: [],
    };
    const config = makeConfig([
      { id: "restricted-model", thinking: [] }, // supports nothing
    ]);

    const result = selectModel("medium", "high", assignments, config, undefined, undefined, ACTIVE_MODEL);
    // When no models support any thinking level, relaxation fails and
    // the code falls back to the unfiltered pool (picks any model).
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "restricted-model");
    assert.equal(result.thinkingLevel, "high");
  });

  it("returns fallback: true when falling back to active model", () => {
    const result = selectModel("frontier", undefined, EMPTY_ASSIGNMENTS, [], undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, true);
  });

  it("returns fallback: false when a model is selected from pool", () => {
    const assignments: BucketAssignments = {
      small: ["model-s"],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-s" }]);

    const result = selectModel("small", undefined, assignments, config, undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, false);
  });

  it("filters by allowedModelIds (provider allowlist)", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["model-a", "model-b", "model-c"],
      frontier: [],
    };
    const config = makeConfig([
      { id: "model-a" },
      { id: "model-b" },
      { id: "model-c" },
    ]);
    const allowed = new Set(["model-b"]);

    const result = selectModel("medium", undefined, assignments, config, allowed, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-b");
    assert.deepEqual(result.pool, ["model-b"]);
  });

  it("falls back to the next lower bucket when provider toggles remove the requested tier", () => {
    const assignments: BucketAssignments = {
      small: ["small-enabled"],
      medium: ["medium-enabled"],
      frontier: ["frontier-disabled"],
    };
    const config = makeConfig([
      { id: "small-enabled" },
      { id: "medium-enabled" },
      { id: "frontier-disabled" },
    ]);

    const result = selectModel(
      "frontier",
      undefined,
      assignments,
      config,
      new Set(["small-enabled", "medium-enabled"]),
      undefined,
      ACTIVE_MODEL,
    );

    assert.equal(result.fallback, false);
    assert.equal(result.bucket, "medium");
    assert.equal(result.modelId, "medium-enabled");
    assert.deepEqual(result.pool, ["medium-enabled"]);
  });

  it("walks past unavailable intermediate buckets without upgrading", () => {
    const assignments: BucketAssignments = {
      small: ["small-enabled"],
      medium: ["medium-disabled"],
      frontier: ["frontier-enabled"],
    };
    const config = makeConfig([
      { id: "small-enabled" },
      { id: "medium-disabled" },
      { id: "frontier-enabled" },
    ]);

    const result = selectModel(
      "medium",
      undefined,
      assignments,
      config,
      new Set(["small-enabled", "frontier-enabled"]),
      undefined,
      ACTIVE_MODEL,
    );

    assert.equal(result.bucket, "small");
    assert.equal(result.modelId, "small-enabled");
  });

  it("does not fall back to an active model excluded by provider toggles", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["model-a"],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-a" }]);
    const allowed = new Set(["model-z"]); // neither bucket nor active model is available

    const result = selectModel("medium", undefined, assignments, config, allowed, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, "");
  });

  it("combines excludeModels and allowedModelIds filters", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["model-a", "model-b"],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-a" }, { id: "model-b" }]);
    const allowed = new Set(["model-a", "model-b"]);
    const exclude = new Set(["model-a"]);

    const result = selectModel("medium", undefined, assignments, config, allowed, exclude, ACTIVE_MODEL);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-b");
  });

  it("soft-filters saturated model ids when another bucket candidate has capacity", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["busy-model", "open-model"],
      frontier: [],
    };
    const config = makeConfig([{ id: "busy-model" }, { id: "open-model" }]);

    const result = selectModel(
      "medium",
      undefined,
      assignments,
      config,
      new Set(["busy-model", "open-model"]),
      undefined,
      ACTIVE_MODEL,
      new Set(["open-model"]),
    );

    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "open-model");
    assert.deepEqual(result.pool, ["open-model"]);
  });

  it("fails open to the old bucket pool when every eligible model is saturated", () => {
    const assignments: BucketAssignments = {
      small: ["busy-a", "busy-b"],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "busy-a" }, { id: "busy-b" }]);

    const result = selectModel(
      "small",
      undefined,
      assignments,
      config,
      new Set(["busy-a", "busy-b"]),
      undefined,
      ACTIVE_MODEL,
      new Set(),
    );

    assert.equal(result.fallback, false);
    assert.ok(["busy-a", "busy-b"].includes(result.modelId));
    assert.deepEqual(result.pool, ["busy-a", "busy-b"]);
  });

  it("keeps old selection behavior when capacity routing is disabled", () => {
    const assignments: BucketAssignments = {
      small: ["model-a"],
      medium: [],
      frontier: [],
    };
    const result = selectModel(
      "small",
      undefined,
      assignments,
      makeConfig([{ id: "model-a" }]),
      new Set(["model-a"]),
      undefined,
      ACTIVE_MODEL,
    );

    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-a");
    assert.deepEqual(result.pool, ["model-a"]);
  });

  it("models not in config are treated as supporting all thinking levels", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["unknown-model"],
      frontier: [],
    };
    // No config entries for unknown-model → treated as supporting all levels
    const config: SimpleModelConfig[] = [];

    const result = selectModel("medium", "xhigh", assignments, config, undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "unknown-model");
  });

  it("undefined excludeModels and allowedModelIds are treated as no filter", () => {
    const assignments: BucketAssignments = {
      small: ["model-s"],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-s" }]);

    const result = selectModel("small", undefined, assignments, config, undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-s");
  });

  it("preserves thinkingLevel in result when provided", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: ["model-m"],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-m" }]);

    const result = selectModel("medium", "high", assignments, config, undefined, undefined, ACTIVE_MODEL);
    assert.equal(result.thinkingLevel, "high");
  });
});

// ============================================================
// loadModelConfig
// ============================================================

describe("loadModelConfig", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-bucket-test-"));
  }

  it("parses valid JSON with profiles", () => {
    const dir = tmpDir();
    try {
      const configPath = path.join(dir, "model-profiles.json");
      fs.writeFileSync(configPath, JSON.stringify({
        profiles: [
          { id: "m1", eligible: true, thinking: ["low", "medium"], disabled_reason: null, cost: 1 },
          { id: "m2", eligible: false, thinking: ["high"], disabled_reason: "deprecated", cost: 2 },
        ],
      }));

      const result = loadModelConfig(configPath);
      assert.equal(result.length, 2);
      assert.equal(result[0].id, "m1");
      assert.deepEqual(result[0].thinking, ["low", "medium"]);
      assert.equal(result[1].id, "m2");
      assert.equal(result[1].eligible, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array for JSON with no profiles key", () => {
    const dir = tmpDir();
    try {
      const configPath = path.join(dir, "model-profiles.json");
      fs.writeFileSync(configPath, JSON.stringify({ other: "data" }));

      const result = loadModelConfig(configPath);
      assert.deepEqual(result, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles missing file by throwing", () => {
    const configPath = path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`);
    assert.throws(() => loadModelConfig(configPath), { code: "ENOENT" });
  });

  it("handles malformed JSON by throwing", () => {
    const dir = tmpDir();
    try {
      const configPath = path.join(dir, "model-profiles.json");
      fs.writeFileSync(configPath, "{ not valid json ");

      assert.throws(() => loadModelConfig(configPath));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses YAML with profiles when yaml module is available", () => {
    // This test depends on the yaml module being resolvable from bucket-selector.ts.
    // If it's not available, loadModelConfig falls back to JSON.
    const dir = tmpDir();
    try {
      const yamlPath = path.join(dir, "model-profiles.yaml");
      fs.writeFileSync(yamlPath, `
profiles:
  - id: yaml-model
    eligible: true
    thinking:
      - low
      - medium
    disabled_reason: null
    cost: 0.5
`);

      // Pass .json path — loadModelConfig replaces .json → .yaml internally
      const jsonPath = path.join(dir, "model-profiles.json");
      const result = loadModelConfig(jsonPath);

      // If yaml module is available, we get 1 entry; otherwise it tries the .json path which doesn't exist
      if (result.length === 1) {
        assert.equal(result[0].id, "yaml-model");
        assert.deepEqual(result[0].thinking, ["low", "medium"]);
        assert.equal(result[0].cost, 0.5);
      }
      // If yaml module not available, the function tries the .json path,
      // which doesn't exist, so it throws — that's expected behavior too.
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// parseProviderToggles
// ============================================================

describe("parseProviderToggles", () => {
  it("parses valid JSON toggles", () => {
    const raw = JSON.stringify({ openai: true, anthropic: false, google: true });
    const result = parseProviderToggles(raw);
    assert.deepEqual(result, { openai: true, anthropic: false, google: true });
  });

  it("returns empty object for undefined input", () => {
    assert.deepEqual(parseProviderToggles(undefined), {});
  });

  it("returns empty object for empty string", () => {
    assert.deepEqual(parseProviderToggles(""), {});
  });

  it("returns empty object for malformed JSON", () => {
    assert.deepEqual(parseProviderToggles("{ not json }"), {});
  });

  it("ignores non-boolean values in toggle object", () => {
    const raw = JSON.stringify({ openai: true, anthropic: "yes", google: 1, other: null });
    const result = parseProviderToggles(raw);
    assert.deepEqual(result, { openai: true });
  });

  it("returns empty object for array input", () => {
    const raw = JSON.stringify(["openai", "anthropic"]);
    assert.deepEqual(parseProviderToggles(raw), {});
  });

  it("returns empty object for null input", () => {
    const raw = JSON.stringify(null);
    assert.deepEqual(parseProviderToggles(raw), {});
  });

  it("handles empty object", () => {
    const raw = JSON.stringify({});
    assert.deepEqual(parseProviderToggles(raw), {});
  });
});

describe("parseSessionProviderToggles", () => {
  it("returns only the requested session's provider map", () => {
    const raw = JSON.stringify({ "/a.jsonl": { fast: false, cheap: true }, "/b.jsonl": { fast: true } });
    assert.deepEqual(parseSessionProviderToggles(raw, "/a.jsonl"), { fast: false, cheap: true });
  });

  it("fails closed to no extra toggles for malformed or missing sessions", () => {
    assert.deepEqual(parseSessionProviderToggles("bad", "/a.jsonl"), {});
    assert.deepEqual(parseSessionProviderToggles(JSON.stringify({}), "/a.jsonl"), {});
    assert.deepEqual(parseSessionProviderToggles(JSON.stringify({ "/a.jsonl": { fast: "no" } }), "/a.jsonl"), {});
  });
});

describe("resolveSubagentProviderToggles", () => {
  it("inherits defaults and lets session-specific values override them", () => {
    assert.deepEqual(
      resolveSubagentProviderToggles(
        { anthropic: false, openai: true },
        { anthropic: true, google: false },
      ),
      { anthropic: true, openai: true, google: false },
    );
  });
});

// ============================================================
// getDisabledProviders
// ============================================================

describe("getDisabledProviders", () => {
  it("returns set of providers with false value", () => {
    const toggles = { openai: true, anthropic: false, google: false };
    const result = getDisabledProviders(toggles);
    assert.deepEqual(result, new Set(["anthropic", "google"]));
  });

  it("returns empty set when all providers are enabled", () => {
    const toggles = { openai: true, anthropic: true };
    assert.deepEqual(getDisabledProviders(toggles), new Set());
  });

  it("returns empty set for empty toggles", () => {
    assert.deepEqual(getDisabledProviders({}), new Set());
  });

  it("returns all providers as disabled when all are false", () => {
    const toggles = { openai: false, anthropic: false };
    const result = getDisabledProviders(toggles);
    assert.deepEqual(result, new Set(["openai", "anthropic"]));
  });
});

// ============================================================
// getAllowedModelIdsForProviders
// ============================================================

describe("getAllowedModelIdsForProviders", () => {
  const models: ModelProviderRef[] = [
    { id: "gpt-4o", provider: "openai" },
    { id: "claude-3.5", provider: "anthropic" },
    { id: "gemini-pro", provider: "google" },
  ];

  it("returns undefined when no providers are disabled", () => {
    const disabled = new Set<string>();
    assert.equal(getAllowedModelIdsForProviders(models, disabled), undefined);
  });

  it("returns allowed model IDs excluding disabled providers", () => {
    const disabled = new Set(["anthropic"]);
    const result = getAllowedModelIdsForProviders(models, disabled);
    assert.ok(result);
    assert.deepEqual(result, new Set(["gpt-4o", "gemini-pro"]));
  });

  it("excludes models from multiple disabled providers", () => {
    const disabled = new Set(["openai", "google"]);
    const result = getAllowedModelIdsForProviders(models, disabled);
    assert.ok(result);
    assert.deepEqual(result, new Set(["claude-3.5"]));
  });

  it("returns empty set when all providers are disabled", () => {
    const disabled = new Set(["openai", "anthropic", "google"]);
    const result = getAllowedModelIdsForProviders(models, disabled);
    assert.ok(result);
    assert.deepEqual(result, new Set());
  });

  it("handles empty models array with disabled providers", () => {
    const disabled = new Set(["openai"]);
    const result = getAllowedModelIdsForProviders([], disabled);
    assert.ok(result);
    assert.deepEqual(result, new Set());
  });
});

// ============================================================
// PROVIDER_TOGGLES_ENV constant
// ============================================================

describe("PROVIDER_TOGGLES_ENV", () => {
  it("has expected value", () => {
    assert.equal(PROVIDER_TOGGLES_ENV, "PIE_PROVIDER_TOGGLES_JSON");
    assert.equal(SUBAGENT_PROVIDER_DEFAULTS_ENV, "PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON");
    assert.equal(SUBAGENT_PROVIDER_TOGGLES_ENV, "PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON");
  });
});

// ============================================================
// parseBucketConfig / readBucketAssignments (user-configured buckets)
// ============================================================

describe("parseBucketConfig", () => {
  it("parses a valid bucket config", () => {
    const result = parseBucketConfig(
      JSON.stringify({ small: ["haiku"], medium: ["sonnet"], frontier: ["opus"] }),
    );
    assert.deepEqual(result, { small: ["haiku"], medium: ["sonnet"], frontier: ["opus"] });
  });

  it("returns empty buckets for undefined input", () => {
    assert.deepEqual(parseBucketConfig(undefined), { small: [], medium: [], frontier: [] });
  });

  it("returns empty buckets for empty string", () => {
    assert.deepEqual(parseBucketConfig(""), { small: [], medium: [], frontier: [] });
  });

  it("returns empty buckets for malformed JSON", () => {
    assert.deepEqual(parseBucketConfig("{ not json"), { small: [], medium: [], frontier: [] });
  });

  it("returns empty buckets for non-object JSON", () => {
    assert.deepEqual(parseBucketConfig(JSON.stringify(["a", "b"])), { small: [], medium: [], frontier: [] });
    assert.deepEqual(parseBucketConfig(JSON.stringify(null)), { small: [], medium: [], frontier: [] });
    assert.deepEqual(parseBucketConfig(JSON.stringify("nope")), { small: [], medium: [], frontier: [] });
  });

  it("defaults missing bucket keys to empty arrays", () => {
    assert.deepEqual(parseBucketConfig(JSON.stringify({ medium: ["sonnet"] })), {
      small: [],
      medium: ["sonnet"],
      frontier: [],
    });
  });

  it("ignores unknown bucket keys", () => {
    const result = parseBucketConfig(
      JSON.stringify({ small: ["haiku"], extra: ["x"], medium: [], frontier: [] }),
    );
    assert.deepEqual(result, { small: ["haiku"], medium: [], frontier: [] });
  });

  it("drops non-array bucket values", () => {
    const result = parseBucketConfig(
      JSON.stringify({ small: "haiku", medium: 5, frontier: ["opus"] }),
    );
    assert.deepEqual(result, { small: [], medium: [], frontier: ["opus"] });
  });

  it("drops non-string and empty-string entries, keeping order", () => {
    const result = parseBucketConfig(
      JSON.stringify({ small: ["haiku", 5, "", null, "mini", "haiku"] }),
    );
    // duplicate "haiku" is de-duplicated; non-string/empty entries dropped
    assert.deepEqual(result.small, ["haiku", "mini"]);
  });

  it("allows the same model id in more than one bucket", () => {
    const result = parseBucketConfig(
      JSON.stringify({ small: ["shared"], medium: ["shared"], frontier: ["shared"] }),
    );
    assert.deepEqual(result, { small: ["shared"], medium: ["shared"], frontier: ["shared"] });
  });
});

describe("readBucketAssignments", () => {
  const previous = process.env[SUBAGENT_BUCKETS_ENV];
  it("reads + parses the env var", () => {
    process.env[SUBAGENT_BUCKETS_ENV] = JSON.stringify({
      small: ["haiku"],
      medium: ["sonnet"],
      frontier: ["opus"],
    });
    try {
      assert.deepEqual(readBucketAssignments(), {
        small: ["haiku"],
        medium: ["sonnet"],
        frontier: ["opus"],
      });
    } finally {
      if (previous === undefined) delete process.env[SUBAGENT_BUCKETS_ENV];
      else process.env[SUBAGENT_BUCKETS_ENV] = previous;
    }
  });

  it("returns empty buckets when the env var is unset", () => {
    delete process.env[SUBAGENT_BUCKETS_ENV];
    try {
      assert.deepEqual(readBucketAssignments(), { small: [], medium: [], frontier: [] });
    } finally {
      if (previous !== undefined) process.env[SUBAGENT_BUCKETS_ENV] = previous;
    }
  });
});

describe("SUBAGENT_BUCKETS_ENV", () => {
  it("has expected value", () => {
    assert.equal(SUBAGENT_BUCKETS_ENV, "PIE_SUBAGENT_BUCKETS_JSON");
  });
});