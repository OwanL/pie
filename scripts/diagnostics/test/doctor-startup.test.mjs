import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const doctorUrl = new URL("../doctor.mjs", import.meta.url);

test("doctor resolves subprocess from its canonical scripts/lib owner", () => {
  const source = readFileSync(doctorUrl, "utf8");
  const match = source.match(/import\s+\{\s*spawnCliSync\s*\}\s+from\s+["']([^"']+)["']/);
  assert.ok(match, "doctor must import spawnCliSync");
  assert.equal(match[1], "../lib/subprocess.mjs");
  assert.equal(existsSync(new URL(match[1], doctorUrl)), true);
});
