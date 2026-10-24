import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionLifecycleStore } from "../../harness/session-storage/lifecycle/session-lifecycle-store.js";

import { verifyPiRuntimeArtifact } from "../../lib/pi-runtime/artifact.mjs";

export async function verifiedSessionRuntimeArgs(cwd: string, dataDir: string, buildId: string): Promise<{
  sdkPath: string;
  args: string[];
}> {
  const configuredSdkPath = process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH;
  const expectedIdentity = process.env.PIE_TEST_PI_RUNTIME_IDENTITY;
  assert.ok(configuredSdkPath, "Set PIE_BUILD_PI_RUNTIME_SDK_PATH to a packaged Pi SDK from the immutable test artifact.");
  assert.ok(expectedIdentity, "Set PIE_TEST_PI_RUNTIME_IDENTITY to the expected verified Pi runtime identity.");
  assert.ok(buildId.trim(), "A non-empty build identity from the test-owned backend artifact is required.");

  const sdkPath = path.resolve(configuredSdkPath);
  const artifactDir = path.resolve(sdkPath, "..", "..", "..");
  const verified = await verifyPiRuntimeArtifact(artifactDir);
  assert.equal(verified.sdkPath, sdkPath, "configured Pi SDK path must be the SDK package root inside the verified artifact");
  assert.equal(verified.identity, expectedIdentity, "test Pi runtime identity must match the verified immutable artifact");

  const descriptor = {
    schemaVersion: 1,
    artifactDir: verified.artifactDir,
    sdkPath: verified.sdkPath,
    cliPath: path.join(verified.sdkPath, "dist", "cli.js"),
    identity: verified.identity,
    manifest: verified.manifest,
  };
  const hostInstanceId = randomUUID();
  const analyticsContext = {
    mode: "canonical-only",
    generationId: randomUUID(),
    buildId,
    workspaceId: path.resolve(cwd),
    hostInstanceId,
  };
  const lifecycleStore = new SessionLifecycleStore(path.join(dataDir, "state", "session-lifecycle.sqlite"));
  try {
    lifecycleStore.registerAnalyticsHost({
      hostInstanceId,
      workspaceId: analyticsContext.workspaceId,
      generationId: hostInstanceId,
      buildId,
      processId: process.pid,
      capabilities: [],
      registeredAtMs: String(Date.now()),
    });
  } finally {
    lifecycleStore.close();
  }
  return {
    sdkPath: verified.sdkPath,
    args: [
      "--sdkPath", verified.sdkPath,
      "--cwd", cwd,
      "--hostPid", String(process.pid),
      "--sourceArtifactDescriptor", JSON.stringify(descriptor),
      "--analyticsContext", JSON.stringify(analyticsContext),
    ],
  };
}

export async function publishTestLiveMembership(
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<{
    ok?: boolean;
    error?: { code?: string; message?: string };
  }>,
  sessionPaths: readonly string[],
): Promise<void> {
  const membership = await request("session.liveMembership", {
    revision: 1,
    timestamp: Date.now(),
    sessions: sessionPaths.map((memberPath, index) => ({
      path: memberPath, name: `Test Session ${index + 1}`, activity: "idle",
    })),
    closing: [],
  });
  assert.equal(membership.ok, true, `test host must publish initial live membership: ${membership.error?.message ?? "unknown error"}`);
}

export async function waitForSessionOpen(
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<{
    ok?: boolean;
    error?: { code?: string; message?: string };
  }>,
  sessionPath: string,
  timeoutMs: number,
  diagnostic?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    const response = await request("session.open", { sessionPath, transcript: "skip" }, Math.min(5_000, Math.max(1, deadline - Date.now())));
    if (response.ok === true) return;
    lastError = `${response.error?.code ?? "RPC_ERROR"}: ${response.error?.message ?? "session.open failed"}`;
    const namespaceNotReady = response.error?.code === "LIVE_TITLE_NAMESPACE_UNAVAILABLE"
      || response.error?.message === "The live session title namespace is not ready.";
    if (!namespaceNotReady) {
      throw new Error(`Could not open the initialized fixture session: ${lastError}${diagnostic?.() ? `\n${diagnostic!()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session.open readiness: ${lastError ?? "no response"}${diagnostic?.() ? `\n${diagnostic!()}` : ""}`);
}
