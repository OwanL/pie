import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectEnvironmentDiagnostics,
  collectWorkspaceDependencyDiagnostics,
  findNodeManagerPathWarnings,
  readEncodingInfo,
  resolveExecutable,
} from "../doctor-environment.mjs";

test("resolves every where.exe match on Windows so PATH collisions are not hidden, with windowsHide", () => {
  const calls = [];
  const result = resolveExecutable("node", {
    platform: "win32",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "C:\\Program Files\\nodejs\\node.exe\r\nC:\\tools\\node.exe\r\n" };
    },
  });

  assert.deepEqual(result, {
    name: "node",
    paths: ["C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\node.exe"],
  });
  assert.deepEqual(calls, [{ command: "where.exe", args: ["node"], options: { encoding: "utf8", windowsHide: true } }]);
});

test("resolves every which -a match on POSIX so PATH collisions are not hidden, with windowsHide", () => {
  const calls = [];
  const result = resolveExecutable("node", {
    platform: "linux",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "/home/me/.nvm/versions/node/v20.11.0/bin/node\n/usr/local/bin/node\n" };
    },
  });

  assert.deepEqual(result, {
    name: "node",
    paths: ["/home/me/.nvm/versions/node/v20.11.0/bin/node", "/usr/local/bin/node"],
  });
  assert.deepEqual(calls, [{ command: "which", args: ["-a", "node"], options: { encoding: "utf8", windowsHide: true } }]);
});

test("treats POSIX misses and unavailable commands as non-results", () => {
  assert.deepEqual(
    resolveExecutable("jq", {
      platform: "linux",
      spawn: () => ({ status: 1, stdout: "/usr/bin/jq\n" }),
    }),
    { name: "jq", paths: [] },
  );
  assert.deepEqual(
    resolveExecutable("jq", { platform: "linux", spawn: () => { throw new Error("unavailable"); } }),
    { name: "jq", paths: [] },
  );
});

test("retains duplicate and cross-manager Node-manager PATH warnings", () => {
  assert.deepEqual(
    findNodeManagerPathWarnings("C:\\Users\\me\\AppData\\Roaming\\nvm;C:\\Users\\me\\AppData\\Roaming\\nvm;C:\\Users\\me\\.volta\\bin", { platform: "win32" }),
    [
      "duplicate Node-manager PATH entry: C:\\Users\\me\\AppData\\Roaming\\nvm",
      "conflicting Node managers on PATH: nvm, volta",
    ],
  );
  assert.deepEqual(
    findNodeManagerPathWarnings("/usr/local/bin:/opt/node/bin", { platform: "linux" }),
    [],
  );
});

test("warns when more than one distinct direct versioned Node directory is on PATH", () => {
  assert.deepEqual(
    findNodeManagerPathWarnings("C:\\nvm\\v20.11.0;C:\\nvm\\v18.20.0", { platform: "win32" }),
    ["multiple versioned Node directories on PATH: C:\\nvm\\v20.11.0, C:\\nvm\\v18.20.0"],
  );
  assert.deepEqual(
    findNodeManagerPathWarnings("/opt/node-v20.11.0-linux-x64/bin:/opt/node-v18.20.0-linux-x64/bin", { platform: "linux" }),
    ["multiple versioned Node directories on PATH: /opt/node-v20.11.0-linux-x64/bin, /opt/node-v18.20.0-linux-x64/bin"],
  );
  assert.deepEqual(
    findNodeManagerPathWarnings("/proto/tools/node/22.22.3:/proto/tools/python/3.12.13", { platform: "linux" }),
    [],
    "versioned non-Node SDK directories must not create a false Node collision",
  );
  // A single versioned directory is not a collision.
  assert.deepEqual(
    findNodeManagerPathWarnings("C:\\nvm\\v20.11.0", { platform: "win32" }),
    [],
  );
  // Duplicate versioned entries collapse to one distinct directory (no collision).
  assert.deepEqual(
    findNodeManagerPathWarnings("C:\\nvm\\v20.11.0;C:\\nvm\\v20.11.0", { platform: "win32" }),
    ["duplicate Node-manager PATH entry: C:\\nvm\\v20.11.0"],
  );
});

test("recognizes nvm-windows nvm4w/nodejs as the nvm manager", () => {
  assert.deepEqual(
    findNodeManagerPathWarnings("C:\\nvm4w\\nodejs;C:\\Users\\me\\.volta\\bin", { platform: "win32" }),
    ["conflicting Node managers on PATH: nvm, volta"],
  );
});

test("does not warn for the standard C:/Program Files/nodejs install alone", () => {
  assert.deepEqual(
    findNodeManagerPathWarnings("C:\\Program Files\\nodejs", { platform: "win32" }),
    [],
  );
  assert.deepEqual(
    findNodeManagerPathWarnings("C:/Program Files/nodejs", { platform: "win32" }),
    [],
  );
});

test("reports LANG/LC_ALL on POSIX without claiming the host encoding is UTF-8", () => {
  assert.deepEqual(
    readEncodingInfo({ platform: "linux", env: { LANG: "en_AU.UTF-8" } }),
    { capturedOutputDecoding: "UTF-8", locale: "en_AU.UTF-8" },
  );
  assert.deepEqual(
    readEncodingInfo({ platform: "linux", env: { LC_ALL: "C.UTF-8", LANG: "C" } }),
    { capturedOutputDecoding: "UTF-8", locale: "C.UTF-8" },
  );
  assert.deepEqual(
    readEncodingInfo({ platform: "linux", env: {} }),
    { capturedOutputDecoding: "UTF-8", locale: "unset" },
  );
});

test("probes the Windows cmd code page via chcp.com (not the cmd built-in spelling)", () => {
  const calls = [];
  const result = readEncodingInfo({
    platform: "win32",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "Active code page: 65001\r\n" };
    },
  });

  assert.deepEqual(result, { capturedOutputDecoding: "UTF-8", codePage: "65001" });
  assert.deepEqual(calls, [{ command: "chcp.com", args: [], options: { encoding: "utf8", windowsHide: true } }]);
});

test("diagnostics stay non-blocking by design when every diagnostic command fails", () => {
  const diagnostics = collectEnvironmentDiagnostics({
    platform: "win32",
    env: { PATH: "C:\\Program Files\\nodejs" },
    executables: ["node"],
    spawn: () => { throw new Error("boom"); },
  });

  assert.deepEqual(diagnostics.executables, [{ name: "node", paths: [] }]);
  assert.equal(diagnostics.encoding.capturedOutputDecoding, "UTF-8");
  assert.equal(diagnostics.encoding.codePage, "unavailable");
  assert.deepEqual(diagnostics.pathWarnings, []);
});

test("collects non-blocking diagnostics through injected process access", () => {
  const diagnostics = collectEnvironmentDiagnostics({
    platform: "linux",
    env: { PATH: "/tools" },
    executables: ["node"],
    spawn: (command, args) => ({ status: 0, stdout: `/resolved/${args[args.length - 1]}\n` }),
  });

  assert.deepEqual(diagnostics, {
    executables: [{ name: "node", paths: ["/resolved/node"] }],
    encoding: { capturedOutputDecoding: "UTF-8", locale: "unset" },
    pathWarnings: [],
  });
});

test("checks the main pnpm workspace read-only through Proto's pinned pnpm", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pie-doctor-pnpm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockfile = path.join(root, "pnpm-lock.yaml");
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n");
  const before = readFileSync(lockfile, "utf8");
  const calls = [];

  const diagnostics = collectWorkspaceDependencyDiagnostics({
    root,
    pinnedPnpm: "10.34.4",
    run(command, args, cwd) {
      calls.push({ command, args, cwd });
      return args.at(-1) === "--version"
        ? { status: 0, stdout: "10.34.4\n" }
        : { status: 0, stdout: "workspace packages ready\n" };
    },
  });

  assert.deepEqual(diagnostics, {
    lockfilePresent: true,
    pinnedPnpm: "10.34.4",
    actualPnpm: "10.34.4",
    pnpmCompatible: true,
    dependenciesChecked: true,
    dependenciesReady: true,
  });
  assert.deepEqual(calls, [
    { command: "proto", args: ["run", "pnpm", "--", "--version"], cwd: root },
    { command: "proto", args: ["run", "pnpm", "--", "list", "--depth=0", "--recursive"], cwd: root },
  ]);
  assert.equal(readFileSync(lockfile, "utf8"), before, "the root lock is never mutated");
});

test("does not query the dependency graph without its root lock or matching Proto pnpm", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pie-doctor-pnpm-gated-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const run = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return { status: 0, stdout: "10.34.3\n" };
  };

  const missingLock = collectWorkspaceDependencyDiagnostics({ root, pinnedPnpm: "10.34.4", run });
  assert.equal(missingLock.lockfilePresent, false);
  assert.equal(missingLock.pnpmCompatible, false);
  assert.equal(missingLock.dependenciesChecked, false);
  assert.equal(calls.length, 1, "only Proto's version probe runs without the main lock");

  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  calls.length = 0;
  const mismatchedTool = collectWorkspaceDependencyDiagnostics({ root, pinnedPnpm: "10.34.4", run });
  assert.equal(mismatchedTool.lockfilePresent, true);
  assert.equal(mismatchedTool.actualPnpm, "10.34.3");
  assert.equal(mismatchedTool.dependenciesChecked, false);
  assert.equal(calls.length, 1, "a mismatched Proto tool never falls back to bare pnpm");
});
