import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { verifyPiRuntimeArtifact } from "../../../../../lib/pi-runtime/artifact.mjs";
import { classifyMcpScriptSource, patchMcpScriptLoadingInSource } from "../../../../../lib/managed-packages/managed-package-contract.mjs";

// Read only the pinned development dependency's exact entry. A caller may
// supply a private unpacked 2.20.1 tarball; installed source is never rewritten.
const packageRoot = process.env.PIE_MCP_FIXTURE_PACKAGE ?? path.dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter"));

test("real pinned MCP entry registers eagerly and fences deferred execution through fresh Jiti", async () => {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, "use test:file --sdk-path with an independently verified runtime");
  const sdkEntry = JSON.parse(readFileSync(config, "utf8")).compilerOptions?.paths?.["@earendil-works/pi-coding-agent"]?.[0];
  assert.ok(sdkEntry && path.isAbsolute(sdkEntry));
  const sdkRoot = path.dirname(path.dirname(sdkEntry));
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, "../../.."));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot);
  const require = createRequire(sdkEntry);
  const jitiPackage = require.resolve("jiti/package.json");
  const jitiUrl = new URL(JSON.parse(readFileSync(jitiPackage, "utf8")).exports["./static"].import, pathToFileURL(jitiPackage)).href;
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-mcp-adapter");
  assert.equal(manifest.version, "2.20.1");
  const source = readFileSync(path.join(packageRoot, "index.ts"), "utf8");
  assert.equal(classifyMcpScriptSource(source), "pristine", "fixture must be the pristine pinned entry");
  const fixture = await mkdtemp(path.join(tmpdir(), "pie-mcp-registration-"));
  try {
    const stub = path.join(fixture, "stubs.ts");
    const names = new Set<string>();
    const modules = new Set<string>();
    for (const match of source.matchAll(/^import \{([^}]+)\} from "(\.\/[^"]+)";/gm)) {
      if (match[2] === "./runtime-owner.ts" || match[2] === "./mcp-code.ts") continue;
      modules.add(match[2]);
      for (const item of match[1].split(",")) {
        const name = item.trim();
        if (!name.startsWith("type ")) names.add(name);
      }
    }
    // Registration dependencies are inert. Initialization returns a private
    // in-memory state; provider/auth/session/network and worker seams never run.
    const overrides: Record<string, string> = {
      cloneMcpConfig: "value => structuredClone(value)",
      loadMcpConfig: "() => ({mcpServers: {}, settings: {}})",
      loadMetadataCache: "() => null",
      resolveDirectTools: "() => []",
      getMissingConfiguredDirectToolServers: "() => []",
      resolveCachedPrompts: "() => []",
      buildProxyDescription: "() => 'fixture proxy description'",
      logger: "({debug() {}, info() {}})",
      formatTerminalError: "String",
      createOAuthRuntime: "() => ({})",
      initializeMcp: "async (_pi, _ctx, owner) => ({owner, config: {mcpServers: {}, settings: {}}, promptMetadata: new Map(), statusEvents: {}, lifecycle: {gracefulShutdown: async () => {}}})",
    };
    await writeFile(stub, [...names].map(name => `export const ${name} = ${overrides[name] ?? "() => undefined"};`).join("\n"));
    const typebox = createRequire(path.join(packageRoot, "package.json")).resolve("typebox");
    for (const variant of ["pristine", "adapted"]) {
      const root = path.join(fixture, variant);
      await mkdir(root);
      for (const name of modules) await writeFile(path.join(root, name.slice(2)), readFileSync(stub, "utf8"));
      await writeFile(path.join(root, "index.ts"), variant === "pristine" ? source : patchMcpScriptLoadingInSource(source));
      await writeFile(path.join(root, "runtime-owner.ts"), readFileSync(path.join(packageRoot, "runtime-owner.ts"), "utf8"));
      await writeFile(path.join(root, "types.ts"), 'export const MCP_STATUS_EVENT = "fixture-status"; export const MCP_STATUS_SNAPSHOT_VERSION = 1; export const MCP_TOOL_APPROVAL_REQUEST_EVENT = "fixture-approval";');
      await writeFile(path.join(root, "mcp-code.ts"), `
        globalThis.control.loads++;
        globalThis.control.entered();
        await globalThis.control.gate;
        export function runMcpScript(...args) {
          globalThis.control.calls.push(args);
          return {content: [{type: 'text', text: 'fixture result'}], details: {mode: 'script'}};
        }
      `);
    }
    // Each scenario uses an entirely fresh process/module graph. The deferred
    // module has an explicit import gate, not a timing assumption or child run.
    for (const scenario of ["concurrent", "shutdown", "recreation"]) {
      const script = `
        import assert from 'node:assert/strict';
        import {createJiti} from ${JSON.stringify(jitiUrl)};
        import Module from 'node:module';
        globalThis.fetch = () => {throw new Error('network forbidden');};
        const originalLoad = Module._load;
        Module._load = function(request, ...args) {
          assert.ok(!/^(?:node:)?(?:child_process|net|http|https)$/.test(request), 'forbidden seam: ' + request);
          return originalLoad.call(this, request, ...args);
        };
        let release;
        const control = globalThis.control = {loads: 0, calls: [], gate: Promise.resolve(), entered() {}};
        const metadata = value => {
          if (typeof value === 'function') return '<function>';
          if (typeof value === 'symbol') return String(value);
          if (Array.isArray(value)) return value.map(metadata);
          if (value && typeof value === 'object') return Object.fromEntries(Reflect.ownKeys(value).map(key => [String(key), metadata(value[key])]));
          return value;
        };
        async function load(variant) {
          const root = ${JSON.stringify(fixture)} + '/' + variant;
          const aliases = {typebox: ${JSON.stringify(typebox)}};
          const jiti = createJiti(import.meta.url, {fsCache: false, alias: aliases});
          const entry = await jiti.import(root + '/index.ts');
          const tools = [], commands = [], flags = [], hooks = new Map();
          const pi = {
            registerTool: tool => tools.push(tool),
            registerCommand: (name, definition) => commands.push({name, ...definition}),
            registerFlag: (name, definition) => flags.push({name, ...definition}),
            on: (name, handler) => hooks.set(name, handler),
            getAllTools: () => [], events: {emit() {}},
          };
          entry.createMcpAdapter({config: {mcpServers: {}, settings: {}}})(pi);
          return {tools, hooks, surface: metadata({tools, commands, flags, hooks: [...hooks].map(([name, handler]) => ({name, handler}))})};
        }
        const baseline = await load('pristine');
        assert.equal(control.loads, 1, 'pristine entry eagerly loads script');
        control.loads = 0;
        const adapted = await load('adapted');
        assert.deepEqual(adapted.tools.map(tool => tool.name), ['mcpScript', 'mcp']);
        assert.deepEqual([...adapted.hooks.keys()], ['session_start', 'session_shutdown', 'tool_result']);
        assert.deepEqual(adapted.surface, baseline.surface, 'all tool/command/flag/hook metadata remains identical');
        assert.equal(control.loads, 0, 'registration must not evaluate script');
        assert.ok(!Object.keys(Module._cache).some(key => /adapted[/\\\\]mcp-code/.test(key)));
        await adapted.hooks.get('session_start')({}, {hasUI: false});
        await new Promise(resolve => setImmediate(resolve));
        control.gate = new Promise(resolve => {release = resolve;});
        const importEntered = new Promise(resolve => {control.entered = resolve;});
        const tool = adapted.tools.find(tool => tool.name === 'mcpScript');
        const abort = new AbortController();
        const pending = tool.execute('one', {code: 'original code', timeoutMs: 417}, abort.signal);
        // Attach a rejection handler before shutdown aborts the old owner.
        const outcome = pending.then(value => ({value}), error => ({error}));
        await importEntered;
        assert.equal(control.calls.length, 0, 'pending import cannot dispatch');
        const scenario = ${JSON.stringify(scenario)};
        let second;
        if (scenario === 'concurrent') second = tool.execute('two', {code: 'second code', timeoutMs: 912}, abort.signal);
        else {
          await adapted.hooks.get('session_shutdown')();
          if (scenario === 'recreation') {
            await adapted.hooks.get('session_start')({}, {hasUI: false});
            await new Promise(resolve => setImmediate(resolve));
          }
        }
        release();
        const result = await outcome;
        if (scenario === 'concurrent') {
          assert.deepEqual(result.value.details, {mode: 'script'});
          await second;
          assert.equal(control.loads, 1, 'concurrent first calls share normal module evaluation');
          assert.equal(control.calls.length, 2);
          assert.deepEqual(control.calls.map(args => args.slice(1, 3)).sort((a, b) => a[0].localeCompare(b[0])), [['original code', 417], ['second code', 912]]);
          for (const args of control.calls) {assert.equal(args[4], abort.signal); assert.equal(typeof args[3], 'function');}
        } else {
          assert.ok(result.error, 'old owner must reject after import resolves');
          assert.equal(control.calls.length, 0, 'stale execution must not dispatch into shutdown/new owner');
          if (scenario === 'recreation') {
            await tool.execute('new', {code: 'new owner', timeoutMs: 73}, abort.signal);
            assert.equal(control.calls.length, 1);
            assert.equal(control.calls[0][1], 'new owner');
          }
        }
        await adapted.hooks.get('session_shutdown')();
        console.log('scenario passed');
      `;
      const { NODE_V8_COVERAGE: _coverage, ...env } = process.env;
      delete env.MCP_DIRECT_TOOLS;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {encoding: "utf8", env, timeout: 30_000});
      assert.equal(result.status, 0, `${scenario}: ${result.stderr || result.stdout}`);
      assert.match(result.stdout, /scenario passed/);
    }
  } finally {
    await rm(fixture, {recursive: true, force: true});
  }
});
