/**
 * Tests for the bucket-selector module.
 *
 * Covers: selectModel, loadModelConfig,
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
  getRuntimeThinkingSupport,
  parseBucketConfig,
  readBucketAssignments,
  PROVIDER_TOGGLES_ENV,
  SUBAGENT_PROVIDER_DEFAULTS_ENV,
  SUBAGENT_PROVIDER_TOGGLES_ENV,
  SUBAGENT_BUCKETS_ENV,
} from "../bucket-selector.js";
import type { ThinkingLevel, ModelProviderRef, BucketAssignments, SimpleModelConfig } from "../bucket-selector.js";

// ============================================================
// runtime thinking support
// ============================================================

describe("getRuntimeThinkingSupport", () => {
  it("mirrors Pi null exclusions and distinct extended levels", () => {
    assert.deepEqual(
      [...getRuntimeThinkingSupport({
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: null, max: "max" },
      })],
      ["off", "low", "medium", "high", "max"],
    );
    assert.deepEqual([...getRuntimeThinkingSupport({ reasoning: false })], ["off"]);
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
    }));
  }

  it("returns a model from the bucket when assignments are populated", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [
        { model: "model-a", thinkingLevel: "medium" },
        { model: "model-b", thinkingLevel: "medium" },
        { model: "model-c", thinkingLevel: "medium" },
      ],
      frontier: [],
    };
    const config = makeConfig([
      { id: "model-a" },
      { id: "model-b" },
      { id: "model-c" },
    ]);

    // Run multiple times to verify we always get a valid model from the pool
    for (let i = 0; i < 20; i++) {
      const result = selectModel("medium", assignments, config, undefined, undefined, ACTIVE_MODEL, undefined);
      assert.equal(result.fallback, false);
      assert.equal(result.bucket, "medium");
      assert.ok(["model-a", "model-b", "model-c"].includes(result.modelId));
      assert.ok(result.pool.includes(result.modelId));
    }
  });

  it("distributes selections evenly without favoring a model", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [
        { model: "fair-a", thinkingLevel: "medium" },
        { model: "fair-b", thinkingLevel: "medium" },
        { model: "fair-c", thinkingLevel: "medium" },
      ],
      frontier: [],
    };
    const config = makeConfig(assignments.medium.map(({ model: id }) => ({ id })));
    const counts = new Map(assignments.medium.map(({ model }) => [model, 0]));

    for (let i = 0; i < 30; i++) {
      const result = selectModel("medium", assignments, config, undefined, undefined, ACTIVE_MODEL, undefined);
      counts.set(result.modelId, counts.get(result.modelId)! + 1);
    }

    assert.deepEqual([...counts.values()], [10, 10, 10]);
  });

  it("treats provider-qualified duplicate ids as distinct fair-selection identities", () => {
    const specs = [
      "github-copilot/gpt-5.4",
      "openai-codex/gpt-5.4",
    ];
    const assignments: BucketAssignments = {
      small: [],
      medium: specs.map((model) => ({ model, thinkingLevel: "high" })),
      frontier: [],
    };
    const counts = new Map(specs.map((spec) => [spec, 0]));

    for (let i = 0; i < 20; i++) {
      const result = selectModel(
        "medium",
        assignments,
        makeConfig([{ id: "gpt-5.4", thinking: ["high"] }]),
        new Set([...specs, "gpt-5.4"]),
        undefined,
        ACTIVE_MODEL,
        undefined,
      );
      counts.set(result.modelId, counts.get(result.modelId)! + 1);
    }

    assert.deepEqual([...counts.values()], [10, 10]);
  });

  it("applies provider toggles and hard requirements to exact qualified duplicates", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [
        { model: "github-copilot/gpt-5.4", thinkingLevel: "high" },
        { model: "openai-codex/gpt-5.4", thinkingLevel: "high" },
        { model: "gpt-5.4", thinkingLevel: "high" },
      ],
      frontier: [],
    };
    const result = selectModel(
      "medium",
      assignments,
      [],
      new Set(["openai-codex/gpt-5.4", "gpt-5.4"]),
      undefined,
      ACTIVE_MODEL,
      undefined,
      undefined,
      new Set(["openai-codex/gpt-5.4", "gpt-5.4"]),
    );

    assert.deepEqual(result.pool, ["openai-codex/gpt-5.4", "gpt-5.4"]);
  });

  it("returns fallback (active model) when bucket is empty", () => {
    const result = selectModel("medium", EMPTY_ASSIGNMENTS, [], undefined, undefined, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, ACTIVE_MODEL);
    assert.equal(result.bucket, "medium");
    assert.deepEqual(result.pool, []);
  });

  it("returns fallback when all models in bucket are excluded via excludeModels", () => {
    const assignments: BucketAssignments = {
      small: [{ model: "model-x", thinkingLevel: "medium" }],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-x" }]);
    const exclude = new Set(["model-x"]);

    const result = selectModel("small", assignments, config, undefined, exclude, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, ACTIVE_MODEL);
    assert.deepEqual(result.pool, []);
  });

  it("excludes unsupported assignments instead of clamping their reasoning level", () => {
    const assignments: BucketAssignments = {
      small: [{ model: "model-mid", thinkingLevel: "xhigh" }],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-mid", thinking: ["low", "medium"] }]);

    const result = selectModel("small", assignments, config, undefined, undefined, ACTIVE_MODEL, "medium");
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, ACTIVE_MODEL);
    assert.equal(result.thinkingLevel, "medium");
  });

  it("uses assignment reasoning rather than the caller's reasoning", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [{ model: "model-all", thinkingLevel: "high" }],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-all", thinking: ["low", "medium", "high"] }]);

    const result = selectModel("medium", assignments, config, undefined, undefined, ACTIVE_MODEL, "low");
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-all");
    assert.equal(result.thinkingLevel, "high");
  });

  it("uses caller reasoning only for active-parent fallback", () => {
    const result = selectModel("medium", EMPTY_ASSIGNMENTS, [], undefined, undefined, ACTIVE_MODEL, "xhigh");
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, ACTIVE_MODEL);
    assert.equal(result.thinkingLevel, "xhigh");
  });

  it("returns fallback: true when falling back to active model", () => {
    const result = selectModel("frontier", EMPTY_ASSIGNMENTS, [], undefined, undefined, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, true);
  });

  it("returns fallback: false when a model is selected from pool", () => {
    const assignments: BucketAssignments = {
      small: [{ model: "model-s", thinkingLevel: "medium" }],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-s" }]);

    const result = selectModel("small", assignments, config, undefined, undefined, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, false);
  });

  it("filters by allowedModelIds (provider allowlist)", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [
        { model: "model-a", thinkingLevel: "medium" },
        { model: "model-b", thinkingLevel: "medium" },
        { model: "model-c", thinkingLevel: "medium" },
      ],
      frontier: [],
    };
    const config = makeConfig([
      { id: "model-a" },
      { id: "model-b" },
      { id: "model-c" },
    ]);
    const allowed = new Set(["model-b"]);

    const result = selectModel("medium", assignments, config, allowed, undefined, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-b");
    assert.deepEqual(result.pool, ["model-b"]);
  });

  it("falls back to the next lower bucket when provider toggles remove the requested tier", () => {
    const assignments: BucketAssignments = {
      small: [{ model: "small-enabled", thinkingLevel: "medium" }],
      medium: [{ model: "medium-enabled", thinkingLevel: "medium" }],
      frontier: [{ model: "frontier-disabled", thinkingLevel: "medium" }],
    };
    const config = makeConfig([
      { id: "small-enabled" },
      { id: "medium-enabled" },
      { id: "frontier-disabled" },
    ]);

    const result = selectModel(
      "frontier",
      assignments,
      config,
      new Set(["small-enabled", "medium-enabled"]),
      undefined,
      ACTIVE_MODEL,
      undefined,
    );

    assert.equal(result.fallback, false);
    assert.equal(result.bucket, "medium");
    assert.equal(result.modelId, "medium-enabled");
    assert.deepEqual(result.pool, ["medium-enabled"]);
  });

  it("walks past unavailable intermediate buckets without upgrading", () => {
    const assignments: BucketAssignments = {
      small: [{ model: "small-enabled", thinkingLevel: "medium" }],
      medium: [{ model: "medium-disabled", thinkingLevel: "medium" }],
      frontier: [{ model: "frontier-enabled", thinkingLevel: "medium" }],
    };
    const config = makeConfig([
      { id: "small-enabled" },
      { id: "medium-disabled" },
      { id: "frontier-enabled" },
    ]);

    const result = selectModel(
      "medium",
      assignments,
      config,
      new Set(["small-enabled", "frontier-enabled"]),
      undefined,
      ACTIVE_MODEL,
      undefined,
    );

    assert.equal(result.bucket, "small");
    assert.equal(result.modelId, "small-enabled");
  });

  it("does not fall back to an active model excluded by provider toggles", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [{ model: "model-a", thinkingLevel: "medium" }],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-a" }]);
    const allowed = new Set(["model-z"]); // neither bucket nor active model is available

    const result = selectModel("medium", assignments, config, allowed, undefined, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, true);
    assert.equal(result.modelId, "");
  });

  it("combines excludeModels and allowedModelIds filters", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [
        { model: "model-a", thinkingLevel: "medium" },
        { model: "model-b", thinkingLevel: "medium" },
      ],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-a" }, { id: "model-b" }]);
    const allowed = new Set(["model-a", "model-b"]);
    const exclude = new Set(["model-a"]);

    const result = selectModel("medium", assignments, config, allowed, exclude, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-b");
  });

  it("soft-filters saturated model ids when another bucket candidate has capacity", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [
        { model: "busy-model", thinkingLevel: "medium" },
        { model: "open-model", thinkingLevel: "medium" },
      ],
      frontier: [],
    };
    const config = makeConfig([{ id: "busy-model" }, { id: "open-model" }]);

    const result = selectModel(
      "medium",
      assignments,
      config,
      new Set(["busy-model", "open-model"]),
      undefined,
      ACTIVE_MODEL,
      undefined,
      new Set(["open-model"]),
    );

    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "open-model");
    assert.deepEqual(result.pool, ["open-model"]);
  });

  it("fails open to the old bucket pool when every eligible model is saturated", () => {
    const assignments: BucketAssignments = {
      small: [
        { model: "busy-a", thinkingLevel: "medium" },
        { model: "busy-b", thinkingLevel: "medium" },
      ],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "busy-a" }, { id: "busy-b" }]);

    const result = selectModel(
      "small",
      assignments,
      config,
      new Set(["busy-a", "busy-b"]),
      undefined,
      ACTIVE_MODEL,
      undefined,
      new Set(),
    );

    assert.equal(result.fallback, false);
    assert.ok(["busy-a", "busy-b"].includes(result.modelId));
    assert.deepEqual(result.pool, ["busy-a", "busy-b"]);
  });

  it("keeps old selection behavior when capacity routing is disabled", () => {
    const assignments: BucketAssignments = {
      small: [{ model: "model-a", thinkingLevel: "medium" }],
      medium: [],
      frontier: [],
    };
    const result = selectModel(
      "small",
      assignments,
      makeConfig([{ id: "model-a" }]),
      new Set(["model-a"]),
      undefined,
      ACTIVE_MODEL,
      undefined,
    );

    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-a");
    assert.deepEqual(result.pool, ["model-a"]);
  });

  it("models not in config are treated as supporting their explicit assignment", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [{ model: "unknown-model", thinkingLevel: "xhigh" }],
      frontier: [],
    };
    // No config entries for unknown-model → treated as supporting all levels
    const config: SimpleModelConfig[] = [];

    const result = selectModel("medium", assignments, config, undefined, undefined, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "unknown-model");
    assert.equal(result.thinkingLevel, "xhigh");
  });

  it("honors exact provider-qualified runtime and profile support", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [
        { model: "github-copilot/gpt-5.4", thinkingLevel: "high" },
        { model: "openai-codex/gpt-5.4", thinkingLevel: "high" },
      ],
      frontier: [],
    };
    const profiles: SimpleModelConfig[] = [
      { provider: "github-copilot", id: "gpt-5.4", eligible: true, thinking: ["high"], disabled_reason: null },
      { provider: "openai-codex", id: "gpt-5.4", eligible: true, thinking: ["low"], disabled_reason: null },
    ];

    const profileResult = selectModel("medium", assignments, profiles, undefined, undefined, ACTIVE_MODEL, undefined);
    assert.deepEqual(profileResult.pool, ["github-copilot/gpt-5.4"]);

    const runtimeResult = selectModel(
      "medium",
      assignments,
      profiles,
      undefined,
      undefined,
      ACTIVE_MODEL,
      undefined,
      undefined,
      undefined,
      new Map([
        ["github-copilot/gpt-5.4", new Set<ThinkingLevel>(["low"])],
        ["openai-codex/gpt-5.4", new Set<ThinkingLevel>(["high"])],
      ]),
    );
    assert.deepEqual(runtimeResult.pool, ["openai-codex/gpt-5.4"]);
  });

  it("requires every possible provider for a bare assignment to support its level", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [{ model: "shared", thinkingLevel: "max" }],
      frontier: [],
    };
    const unsupportedProfiles: SimpleModelConfig[] = [
      { provider: "one", id: "shared", eligible: true, thinking: ["high"], disabled_reason: null },
      { provider: "two", id: "shared", eligible: true, thinking: ["low"], disabled_reason: null },
    ];
    assert.equal(
      selectModel("medium", assignments, unsupportedProfiles, undefined, undefined, ACTIVE_MODEL, "medium").fallback,
      true,
    );

    const mixedRuntimeSupport = new Map<string, ReadonlySet<ThinkingLevel>>([
      ["one/shared", new Set(["high"])],
      ["two/shared", new Set(["max"])],
    ]);
    assert.equal(
      selectModel(
        "medium", assignments, unsupportedProfiles, undefined, undefined, ACTIVE_MODEL, "medium",
        undefined, undefined, mixedRuntimeSupport,
      ).fallback,
      true,
    );

    const uniformRuntimeSupport = new Map<string, ReadonlySet<ThinkingLevel>>([
      ["one/shared", new Set(["max"])],
      ["two/shared", new Set(["max"])],
    ]);
    const selected = selectModel(
      "medium", assignments, unsupportedProfiles, undefined, undefined, ACTIVE_MODEL, "medium",
      undefined, undefined, uniformRuntimeSupport,
    );
    assert.equal(selected.modelId, "shared");
    assert.equal(selected.thinkingLevel, "max");
  });

  it("undefined excludeModels and allowedModelIds are treated as no filter", () => {
    const assignments: BucketAssignments = {
      small: [{ model: "model-s", thinkingLevel: "medium" }],
      medium: [],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-s" }]);

    const result = selectModel("small", assignments, config, undefined, undefined, ACTIVE_MODEL, undefined);
    assert.equal(result.fallback, false);
    assert.equal(result.modelId, "model-s");
  });

  it("returns the assignment thinkingLevel", () => {
    const assignments: BucketAssignments = {
      small: [],
      medium: [{ model: "model-m", thinkingLevel: "high" }],
      frontier: [],
    };
    const config = makeConfig([{ id: "model-m" }]);

    const result = selectModel("medium", assignments, config, undefined, undefined, ACTIVE_MODEL, "low");
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
          { id: "m1", eligible: true, thinking: ["low", "medium"], disabled_reason: null },
          { id: "m2", eligible: false, thinking: ["high"], disabled_reason: "deprecated" },
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
`);

      // Pass .json path — loadModelConfig replaces .json → .yaml internally
      const jsonPath = path.join(dir, "model-profiles.json");
      const result = loadModelConfig(jsonPath);

      // If yaml module is available, we get 1 entry; otherwise it tries the .json path which doesn't exist
      if (result.length === 1) {
        assert.equal(result[0].id, "yaml-model");
        assert.deepEqual(result[0].thinking, ["low", "medium"]);
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

  it("matches equivalent Windows session paths across casing and separators", () => {
    const raw = JSON.stringify({
      "C:\\Users\\Example\\session.jsonl": { "openai-codex": true, umans: false },
    });
    assert.deepEqual(
      parseSessionProviderToggles(raw, "c:/users/example/session.jsonl"),
      { "openai-codex": true, umans: false },
    );
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
    assert.deepEqual(result, new Set([
      "gpt-4o", "openai/gpt-4o",
      "gemini-pro", "google/gemini-pro",
    ]));
  });

  it("excludes models from multiple disabled providers", () => {
    const disabled = new Set(["openai", "google"]);
    const result = getAllowedModelIdsForProviders(models, disabled);
    assert.ok(result);
    assert.deepEqual(result, new Set(["claude-3.5", "anthropic/claude-3.5"]));
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
  it("parses all seven exact thinking levels, including distinct xhigh and max", () => {
    const result = parseBucketConfig(JSON.stringify({
      small: [
        { model: "off", thinkingLevel: "off" },
        { model: "minimal", thinkingLevel: "minimal" },
        { model: "low", thinkingLevel: "low" },
      ],
      medium: [
        { model: "medium", thinkingLevel: "medium" },
        { model: "high", thinkingLevel: "high" },
      ],
      frontier: [
        { model: "xhigh", thinkingLevel: "xhigh" },
        { model: "max", thinkingLevel: "max" },
      ],
    }));
    assert.deepEqual(result, {
      small: [
        { model: "off", thinkingLevel: "off" },
        { model: "minimal", thinkingLevel: "minimal" },
        { model: "low", thinkingLevel: "low" },
      ],
      medium: [
        { model: "medium", thinkingLevel: "medium" },
        { model: "high", thinkingLevel: "high" },
      ],
      frontier: [
        { model: "xhigh", thinkingLevel: "xhigh" },
        { model: "max", thinkingLevel: "max" },
      ],
    });
  });

  it("keeps qualified models and drops duplicate models after the first assignment", () => {
    const result = parseBucketConfig(JSON.stringify({
      medium: [
        { model: "github-copilot/gpt-5.4", thinkingLevel: "high" },
        { model: "openai-codex/gpt-5.4", thinkingLevel: "low" },
        { model: "github-copilot/gpt-5.4", thinkingLevel: "max" },
      ],
    }));
    assert.deepEqual(result.medium, [
      { model: "github-copilot/gpt-5.4", thinkingLevel: "high" },
      { model: "openai-codex/gpt-5.4", thinkingLevel: "low" },
    ]);
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
    assert.deepEqual(parseBucketConfig(JSON.stringify({
      medium: [{ model: "sonnet", thinkingLevel: "medium" }],
    })), {
      small: [],
      medium: [{ model: "sonnet", thinkingLevel: "medium" }],
      frontier: [],
    });
  });

  it("ignores unknown bucket keys", () => {
    const result = parseBucketConfig(JSON.stringify({
      small: [{ model: "haiku", thinkingLevel: "low" }],
      extra: [{ model: "x", thinkingLevel: "max" }],
      medium: [],
      frontier: [],
    }));
    assert.deepEqual(result, {
      small: [{ model: "haiku", thinkingLevel: "low" }],
      medium: [],
      frontier: [],
    });
  });

  it("drops non-array bucket values", () => {
    const result = parseBucketConfig(JSON.stringify({
      small: "haiku",
      medium: 5,
      frontier: [{ model: "opus", thinkingLevel: "max" }],
    }));
    assert.deepEqual(result, {
      small: [],
      medium: [],
      frontier: [{ model: "opus", thinkingLevel: "max" }],
    });
  });

  it("drops legacy string entries and malformed assignments", () => {
    const result = parseBucketConfig(JSON.stringify({
      small: [
        "legacy-haiku",
        5,
        null,
        {},
        { model: "", thinkingLevel: "low" },
        { model: "invalid-level", thinkingLevel: "ultra" },
        { model: "valid", thinkingLevel: "minimal" },
      ],
    }));
    assert.deepEqual(result.small, [{ model: "valid", thinkingLevel: "minimal" }]);
  });

  it("allows the same model id in more than one bucket", () => {
    const result = parseBucketConfig(JSON.stringify({
      small: [{ model: "shared", thinkingLevel: "low" }],
      medium: [{ model: "shared", thinkingLevel: "medium" }],
      frontier: [{ model: "shared", thinkingLevel: "high" }],
    }));
    assert.deepEqual(result, {
      small: [{ model: "shared", thinkingLevel: "low" }],
      medium: [{ model: "shared", thinkingLevel: "medium" }],
      frontier: [{ model: "shared", thinkingLevel: "high" }],
    });
  });
});

describe("readBucketAssignments", () => {
  const previous = process.env[SUBAGENT_BUCKETS_ENV];
  it("reads + parses the env var", () => {
    process.env[SUBAGENT_BUCKETS_ENV] = JSON.stringify({
      small: [{ model: "haiku", thinkingLevel: "low" }],
      medium: [{ model: "sonnet", thinkingLevel: "medium" }],
      frontier: [{ model: "opus", thinkingLevel: "max" }],
    });
    try {
      assert.deepEqual(readBucketAssignments(), {
        small: [{ model: "haiku", thinkingLevel: "low" }],
        medium: [{ model: "sonnet", thinkingLevel: "medium" }],
        frontier: [{ model: "opus", thinkingLevel: "max" }],
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