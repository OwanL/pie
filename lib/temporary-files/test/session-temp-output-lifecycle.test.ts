import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { lstat as nodeLstat, mkdir, mkdtemp, unlink as nodeUnlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupSessionTempOutputManifests,
  cleanupSessionTempOutputs,
  createSessionTempOutput,
  setSessionTempOutputFileSystemForTesting,
  trackSessionTempOutput,
} from "../session-temp-output-lifecycle.js";

function id(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function sdkOutputPath(): string {
  return join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
}

test("failed lstat/unlink keeps ownership for retry and never removes another session's output", async () => {
  for (const failure of ["lstat", "unlink"] as const) {
    const sessionId = id(`failure-${failure}`);
    const otherSessionId = id("unrelated");
    const owner = {};
    const otherOwner = {};
    const outputPath = sdkOutputPath();
    const otherOutputPath = sdkOutputPath();
    writeFileSync(outputPath, "private session output");
    writeFileSync(otherOutputPath, "other session output");
    await trackSessionTempOutput(sessionId, "bash", outputPath, owner);
    await trackSessionTempOutput(otherSessionId, "bash", otherOutputPath, otherOwner);

    let failedOnce = false;
    setSessionTempOutputFileSystemForTesting({
      ...(failure === "lstat" ? {
        lstat: async (filePath: Parameters<typeof nodeLstat>[0]) => {
          if (String(filePath) === outputPath && !failedOnce) {
            failedOnce = true;
            throw Object.assign(new Error("injected lstat failure"), { code: "EACCES" });
          }
          return await nodeLstat(filePath);
        },
      } : {}),
      ...(failure === "unlink" ? {
        unlink: async (filePath: Parameters<typeof nodeUnlink>[0]) => {
          if (String(filePath) === outputPath && !failedOnce) {
            failedOnce = true;
            throw Object.assign(new Error("injected unlink failure"), { code: "EBUSY" });
          }
          return await nodeUnlink(filePath);
        },
      } : {}),
    });
    try {
      await assert.rejects(cleanupSessionTempOutputs(sessionId, owner), /Could not purge temporary outputs/);
      assert.equal(existsSync(outputPath), true, `${failure} failure must retain the file for retry`);
      assert.equal(existsSync(otherOutputPath), true, "a different session's output must not be touched");
    } finally {
      setSessionTempOutputFileSystemForTesting(null);
    }

    try {
      await cleanupSessionTempOutputs(sessionId, owner);
      assert.equal(existsSync(outputPath), false, "retry must remove the retained owner file");
      assert.equal(existsSync(otherOutputPath), true, "retry must still leave the other session alone");
    } finally {
      await cleanupSessionTempOutputs(otherSessionId, otherOwner);
      rmSync(outputPath, { force: true });
      rmSync(otherOutputPath, { force: true });
    }
  }
});

test("closed lifecycle identity survives more than 256 sessions and unlinks a late callback", async () => {
  const owners: object[] = [];
  const sessionIds: string[] = [];
  for (let index = 0; index < 300; index++) {
    const sessionId = id(`closed-${index}`);
    const owner = {};
    sessionIds.push(sessionId);
    owners.push(owner);
    await cleanupSessionTempOutputs(sessionId, owner);
  }

  const latePath = sdkOutputPath();
  writeFileSync(latePath, "late callback output");
  try {
    await trackSessionTempOutput(sessionIds[0], "bash", latePath, owners[0]!);
    assert.equal(existsSync(latePath), false, "the old lifecycle fence must not be evicted by unrelated session count");
  } finally {
    rmSync(latePath, { force: true });
  }
});

test("coordinator manifest purge removes root and descendant output but not another root", async () => {
  const rootSessionId = id("private-root");
  const childSessionId = id("private-child");
  const otherSessionId = id("other-root");
  const rootOwner = {};
  const childOwner = {};
  const otherOwner = {};
  const rootPath = sdkOutputPath();
  const childPath = join(tmpdir(), `pruned-raw-${childSessionId}-${randomBytes(8).toString("hex")}.txt`);
  const otherPath = sdkOutputPath();
  writeFileSync(rootPath, "root output");
  writeFileSync(otherPath, "other output");

  await trackSessionTempOutput(rootSessionId, "bash", rootPath, rootOwner, rootSessionId);
  assert.equal(await createSessionTempOutput(
    childSessionId,
    rootSessionId,
    childOwner,
    childPath,
    async () => await writeFile(childPath, "descendant recall raw"),
  ), true);
  await trackSessionTempOutput(otherSessionId, "bash", otherPath, otherOwner, otherSessionId);

  try {
    await cleanupSessionTempOutputManifests(rootSessionId);
    assert.equal(existsSync(rootPath), false);
    assert.equal(existsSync(childPath), false, "root purge includes descendant pruning raw output");
    assert.equal(existsSync(otherPath), true, "another root's manifest and file must remain untouched");
  } finally {
    await cleanupSessionTempOutputs(rootSessionId, rootOwner, rootSessionId);
    await cleanupSessionTempOutputs(childSessionId, childOwner, rootSessionId);
    await cleanupSessionTempOutputs(otherSessionId, otherOwner, otherSessionId);
    rmSync(rootPath, { force: true });
    rmSync(childPath, { force: true });
    rmSync(otherPath, { force: true });
  }
});

test("private close retries a manifest after output unlink failure", async () => {
  const rootSessionId = id("manifest-retry");
  const sessionId = id("manifest-retry-session");
  const owner = {};
  const outputPath = sdkOutputPath();
  writeFileSync(outputPath, "private output");
  await trackSessionTempOutput(sessionId, "bash", outputPath, owner, rootSessionId);

  const fs = await import("node:fs/promises");
  let failedOnce = false;
  setSessionTempOutputFileSystemForTesting({
    unlink: async (filePath) => {
      if (String(filePath) === outputPath && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error("injected coordinator unlink failure"), { code: "EBUSY" });
      }
      return await fs.unlink(filePath);
    },
  });
  try {
    await assert.rejects(cleanupSessionTempOutputManifests(rootSessionId), /Could not purge \d+ coordinator-owned/);
    assert.equal(existsSync(outputPath), true);
  } finally {
    setSessionTempOutputFileSystemForTesting(null);
  }

  try {
    await cleanupSessionTempOutputManifests(rootSessionId);
    assert.equal(existsSync(outputPath), false);
  } finally {
    await cleanupSessionTempOutputs(sessionId, owner, rootSessionId);
    rmSync(outputPath, { force: true });
  }
});

test("manifest cleanup refuses a non-file and retains ownership for retry", async () => {
  const rootSessionId = id("no-follow-root");
  const sessionId = id("no-follow-session");
  const owner = {};
  const temp = await mkdtemp(join(tmpdir(), "pie-session-temp-output-test-"));
  const unrelated = join(temp, "user-file.txt");
  const outputPath = sdkOutputPath();
  await mkdir(outputPath);
  writeFileSync(unrelated, "untouched");
  await trackSessionTempOutput(sessionId, "bash", outputPath, owner, rootSessionId);

  try {
    await assert.rejects(cleanupSessionTempOutputManifests(rootSessionId), /Could not purge \d+ coordinator-owned/);
    assert.equal(existsSync(outputPath), true, "directories at a recorded output path must not be removed");
    assert.equal(existsSync(unrelated), true);
    rmSync(outputPath, { recursive: true, force: true });
    await cleanupSessionTempOutputManifests(rootSessionId);
    assert.equal(existsSync(unrelated), true);
  } finally {
    await cleanupSessionTempOutputs(sessionId, owner, rootSessionId);
    rmSync(outputPath, { recursive: true, force: true });
    rmSync(unrelated, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
