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

test("doctor checks the Proto-resolved pnpm workspace, not npm trees or secondary locks", () => {
  const source = readFileSync(doctorUrl, "utf8");
  assert.match(source, /readPinnedPnpmVersion/);
  assert.match(source, /collectWorkspaceDependencyDiagnostics\(\{ root: repoRoot, pinnedPnpm, run \}\)/);
  assert.doesNotMatch(source, /readPinnedNpmVersion|run\("npm"|package-lock\.json/);
});

test("doctor recovery advice uses gated setup and explicit delivery or verified reuse", () => {
  const source = readFileSync(doctorUrl, "utf8");
  assert.match(source, /stop isolated development hosts, then run proto run pnpm -- run setup/);
  assert.match(source, /workspace-reader gate must be clear; preserve installed Pie/);
  assert.doesNotMatch(source, /install --frozen-lockfile|Build the checkout's VS Code application/);
  assert.match(source, /proto run pnpm -- run delivery:build/);
  assert.match(source, /ordinary build writes out-dev, not this delivery artifact/);
  assert.match(source, /--pi-runtime <absolute verified artifact root> to reuse an artifact/);
});
