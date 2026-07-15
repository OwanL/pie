import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderFailure,
  markProviderReplayUnsafe,
  readFallbackOnProviderFailure,
  SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV,
} from "../src/provider-failure.js";
import type { SingleResult } from "../types.js";

function failure(over: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "worker",
    agentSource: "user",
    task: "task",
    exitCode: 1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stopReason: "error",
    ...over,
  };
}

test("provider fallback defaults on and accepts explicit off", () => {
  const previous = process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV];
  try {
    delete process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV];
    assert.equal(readFallbackOnProviderFailure(), true);
    process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV] = "0";
    assert.equal(readFallbackOnProviderFailure(), false);
    process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV] = "false";
    assert.equal(readFallbackOnProviderFailure(), false);
    process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV] = "1";
    assert.equal(readFallbackOnProviderFailure(), true);
  } finally {
    if (previous === undefined) delete process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV];
    else process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV] = previous;
  }
});

test("classifies exhausted connection timeout as replay-safe and retryable", () => {
  const result = failure();
  classifyProviderFailure(result, Object.assign(new Error("connection timed out; retries exhausted"), { code: "ETIMEDOUT" }));
  assert.equal(result.failureClass, "timeout");
  assert.equal(result.retryable, true);
  assert.equal(result.replaySafety, "safe");
});

test("explicit client responses remain terminal even when retries were exhausted", () => {
  const result = failure();
  classifyProviderFailure(result, Object.assign(new Error("maximum retries exceeded"), { status: 400 }));
  assert.equal(result.failureClass, "unknown");
  assert.equal(result.retryable, false);
  assert.equal(result.replaySafety, "safe");

  const textOnly = failure();
  classifyProviderFailure(textOnly, new Error("HTTP 400 Bad Request: maximum retries exceeded"));
  assert.equal(textOnly.failureClass, "unknown");
  assert.equal(textOnly.retryable, false);

  const responseCode = failure();
  classifyProviderFailure(responseCode, new Error("HTTPError: Response code 400 (Bad Request): maximum retries exceeded"));
  assert.equal(responseCode.failureClass, "unknown");
  assert.equal(responseCode.retryable, false);
});

test("auth failures and semantic model errors are terminal", () => {
  const auth = failure();
  classifyProviderFailure(auth, Object.assign(new Error("Unauthorized: invalid API key"), { status: 401 }));
  assert.equal(auth.failureClass, "auth");
  assert.equal(auth.retryable, false);

  const semantic = failure({ errorMessage: "Tool arguments failed schema validation" });
  classifyProviderFailure(semantic);
  assert.equal(semantic.failureClass, "unknown");
  assert.equal(semantic.retryable, false);
});

test("visible output and tool execution prevent replay", () => {
  const partial = failure();
  markProviderReplayUnsafe(partial, "partial_output");
  classifyProviderFailure(partial, new Error("fetch failed"));
  assert.equal(partial.retryable, true);
  assert.equal(partial.replaySafety, "partial_output");

  const tool = failure();
  markProviderReplayUnsafe(tool, "tool_side_effect");
  classifyProviderFailure(tool, new Error("socket hang up"));
  assert.equal(tool.retryable, true);
  assert.equal(tool.replaySafety, "tool_side_effect");
});
