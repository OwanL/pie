import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded, createJsonMutex } from "../run.mjs";
import { atomicJson } from "../lib/core.mjs";

const tick = (ms = 1) => new Promise(ok => setTimeout(ok, ms));

test("runBounded never exceeds maxConcurrency", async () => {
  let active = 0, maxActive = 0;
  const items = Array.from({ length: 30 }, (_, i) => i);
  await runBounded(items, 4, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick(2 + Math.floor(Math.random() * 6));
    active--;
  });
  assert.equal(maxActive, 4, `peak concurrency was ${maxActive}, expected 4`);
});

test("runBounded with maxConcurrency 1 runs strictly serially", async () => {
  const order = [];
  let active = 0, maxActive = 0;
  await runBounded([0, 1, 2, 3], 1, async (i) => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start-${i}`);
    await tick(3);
    order.push(`end-${i}`);
    active--;
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start-0", "end-0", "start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});

test("runBounded processes every item exactly once", async () => {
  const seen = [];
  await runBounded([10, 20, 30, 40, 50], 3, async (i) => { seen.push(i); await tick(); });
  assert.deepEqual(seen.sort((a, b) => a - b), [10, 20, 30, 40, 50]);
});

test("runBounded with empty items resolves without invoking the worker", async () => {
  let calls = 0;
  await runBounded([], 4, async () => { calls++; });
  assert.equal(calls, 0);
});

test("runBounded stops launching after an error but drains in-flight workers", async () => {
  const started = [], finished = [];
  await assert.rejects(
    runBounded([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
      started.push(i);
      await tick(15);
      finished.push(i);
      if (i === 1) throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(started.length, finished.length, "all started workers drained");
  assert.ok(started.length < 8, `launching did not stop: ${started.length}`);
  assert.ok(started.length <= 3, `too many started: ${started.length}`);
});

test("createJsonMutex loses no completedTrialIds under concurrent updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pie-mutex-"));
  const path = join(dir, "experiment.json");
  await writeFile(path, JSON.stringify({ completedTrialIds: [] }));
  const update = createJsonMutex(path);
  const ids = Array.from({ length: 40 }, (_, i) =>
    `task--umans-glm-5.2--off--r${i + 1}--${i % 2 ? "candidate" : "baseline"}`);
  await Promise.all(ids.map(id => update(cur => {
    cur.completedTrialIds = [...new Set([...(cur.completedTrialIds || []), id])].sort();
  })));
  const final = JSON.parse(await readFile(path, "utf8"));
  assert.equal(final.completedTrialIds.length, ids.length, "no trial id was lost");
  for (const id of ids) assert.ok(final.completedTrialIds.includes(id), `missing ${id}`);
  await rm(dir, { recursive: true, force: true });
});

test("progress snapshot pattern writes immutable queued snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pie-snapshot-"));
  const path = join(dir, "progress.json");
  await writeFile(path, JSON.stringify({ counter: 0 }));
  const activeTrials = new Map();
  let progress = { counter: 0, activeTrials: [], acceptedRequests: 0 };
  let chain = Promise.resolve();
  const update = (patch) => {
    const active = [...activeTrials.values()];
    const snapshot = {
      ...progress,
      ...(patch || {}),
      activeTrials: active.map(t => ({ ...t })),
      acceptedRequests: active.reduce((n, t) => n + (t.acceptedRequests || 0), 0),
      updatedAt: Date.now(),
    };
    progress = snapshot;
    const write = atomicJson(path, snapshot).then(() => snapshot);
    chain = chain.then(() => write);
    return chain;
  };

  activeTrials.set("a", { acceptedRequests: 1 });
  const p1 = update({ counter: 1 });
  activeTrials.get("a").acceptedRequests = 99;
  const p2 = update({ counter: 2 });
  const [s1, s2] = await Promise.all([p1, p2]);

  assert.notEqual(s1, s2, "snapshots are distinct objects");
  assert.equal(s1.activeTrials[0].acceptedRequests, 1, "first snapshot captured value at call time");
  assert.equal(s2.activeTrials[0].acceptedRequests, 99, "second snapshot captured mutated value");
  assert.equal(s1.counter, 1);
  assert.equal(s2.counter, 2);
  await rm(dir, { recursive: true, force: true });
});

test("createJsonMutex serializes overlapping mutations without lost updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pie-mutex-"));
  const path = join(dir, "state.json");
  await writeFile(path, JSON.stringify({ counter: 0, tags: [] }));
  const update = createJsonMutex(path);
  const N = 50;
  await Promise.all(Array.from({ length: N }, (_, i) => update(cur => {
    cur.counter += 1;
    cur.tags.push(i);
  })));
  const final = JSON.parse(await readFile(path, "utf8"));
  assert.equal(final.counter, N, "every increment was applied");
  assert.equal(final.tags.length, N, "every tag was applied");
  await rm(dir, { recursive: true, force: true });
});
