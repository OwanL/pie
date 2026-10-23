import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runTypecheckLocal } from '../typecheck-project.mjs';
import { runNodeTests } from '../test-node.mjs';

// Fake compiler children only: no compiler or uncertain descendants are launched.
test('local uncertainty retains unique bounded receipts and original causes', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-synthetic-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tsconfig.json');
  const compilerPath = path.join(root, 'fake-compiler.cjs');
  writeFileSync(configPath, '{"files":[]}');
  writeFileSync(compilerPath, '// never executed');
  const paths = new Set();
  for (const mode of ['unknown', 'reject', 'setup', 'write', 'success', 'failure']) {
    const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const cause = new Error(`synthetic ${mode}`);
    const running = runTypecheckLocal({ root, configPath, compilerPath,
      spawnImpl: () => child,
      watchChildProcessImpl: () => {
        if (mode === 'setup') throw cause;
        return { timedOut: false, aborted: false, settle: async () => {
          if (mode === 'reject') throw cause;
          return { gone: ['success', 'failure'].includes(mode), diagnostics: ['token=private'], ownedProcesses: [{ pid: 42, identity: 'fake', secret: 'excluded' }] };
        } };
      },
      ...(mode === 'write' ? { writeDiagnosticImpl: () => { throw cause; } } : {}),
    });
    child.stdout.emit('data', 'x'.repeat(100000));
    child.emit('close', mode === 'failure' ? 2 : 0);
    if (['success', 'failure'].includes(mode)) {
      const result = await running;
      assert.equal(result.teardownConfirmed, true);
      assert.equal(result.code, mode === 'failure' ? 2 : 0);
      continue;
    }
    await assert.rejects(running, error => {
      assert.equal(error.teardownUnconfirmed, true);
      assert.equal(error.root, root);
      assert.ok(existsSync(error.overlayPath));
      assert.ok(!paths.has(error.diagnosticPath));
      paths.add(error.diagnosticPath);
      if (mode === 'reject' || mode === 'setup') assert.equal(error, cause);
      if (mode === 'write') assert.equal(error.diagnosticWriteError, cause);
      else {
        const raw = readFileSync(error.diagnosticPath, 'utf8');
        const receipt = JSON.parse(raw);
        assert.equal(receipt.gone, false);
        assert.equal(receipt.childPid, 42);
        assert.ok(receipt.output.length <= 16384);
        assert.ok(!raw.includes('private'));
        assert.ok(!raw.includes('excluded'));
      }
      return true;
    });
  }
  assert.equal(paths.size, 4);
});

test('enclosing teardown diagnostic proof requires positive watchdog confirmation', async () => {
  // No real child admission: fake ownership evidence tests the proof boundary.
  for (const gone of [false, undefined, 'truthy is not proof', true]) {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end() {} }),
    });
    const running = runNodeTests([], {
      spawnImpl: () => child,
      watchChildProcessImpl: () => ({ ownershipReady: true, settle: async () => ({ gone }) }),
    });
    child.emit('close', 125);
    let retained;
    await assert.rejects(running, error => {
      retained = error.diagnosticPath;
      assert.equal(error.teardownUnconfirmed, true);
      assert.equal(error.enclosingTeardownConfirmed, gone === true ? true : undefined);
      assert.ok(existsSync(retained));
      return true;
    });
    // Fake children cannot own descendants; only these synthetic artifacts may
    // be removed without real enclosing teardown proof.
    rmSync(gone === true ? retained : path.dirname(retained), { recursive: true, force: true });
  }
});

test('actual isolated Node failure serialization preserves sticky uncertainty, not expected rejections', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-synthetic-serialization-'));
  let enclosingUnknown = false;
  const run = async () => {
    try { return await runNodeTests([source], { env }); }
    catch (error) {
      // Latch before assertion callbacks or t.after can run. An actual unknown
      // enclosing tree must retain both this fixture and the runner's config.
      enclosingUnknown ||= error?.teardownUnconfirmed === true && error.enclosingTeardownConfirmed !== true;
      throw error;
    }
  };
  t.after(() => { if (!enclosingUnknown) rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'synthetic.test.mjs');
  const base = "import test from 'node:test'; import assert from 'node:assert/strict';\n";
  writeFileSync(source, base + "test('expected', async () => { await assert.rejects(Promise.reject(Object.assign(new Error('expected'), {teardownUnconfirmed:true}))); });\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ordinary = await run();
  assert.equal(ordinary.code, 0);
  assert.equal(ordinary.teardownConfirmed, true);
  writeFileSync(source, base + "test('simulated unknown', () => { throw new Error('wrapper', {cause:Object.assign(new AggregateError([new Error('synthetic only')], 'aggregate wrapper'), {teardownUnconfirmed:true,diagnosticPath:'synthetic'})}); }); test('later ordinary', () => { assert.fail('ordinary'); });\n");
  let retained;
  await assert.rejects(run(), error => {
    assert.equal(error.teardownUnconfirmed, true);
    assert.equal(error.enclosingTeardownConfirmed, true, 'must be nested simulated uncertainty, not actual watchdog uncertainty');
    retained = error.diagnosticPath;
    assert.ok(existsSync(retained));
    return true;
  });
  // Simulated metadata only; the production watchdog has confirmed this owned
  // child tree gone before returning the nested uncertainty. No real leak.
  rmSync(retained, { recursive: true, force: true });
});
