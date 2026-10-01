import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { events, makeFixture, makePinnedArtifact, startWatch, waitFor } from './build-lifecycle.test.mjs';

function outputDir(fixture) {
  return path.join(fixture.owner, 'out');
}

function rendererCount(fixture) {
  return events(fixture).filter(item => item.event === 'renderer-publication').length;
}

function startWatchBuild(t, fixture, args = ['--watch']) {
  const child = startWatch(fixture, args);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.connected) child.send('fixture:SIGTERM');
    else child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return child;
}

async function stopWatch(child) {
  if (process.platform === 'win32') child.send('fixture:SIGTERM');
  else child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, child, 'watch cancellation');
  assert.equal(child.exitCode, 0, `${child.stdoutText}\n${child.stderrText}`);
}

test('watch reuses app-only selection, rotates after drain, and suppresses stale acquisition publication', async (t) => {
  const fixture = makeFixture(t, { webviewFails: false });
  writeFileSync(path.join(fixture.controls, 'hold-2'), 'hold');
  const child = startWatchBuild(t, fixture);
  const out = outputDir(fixture);
  await waitFor(() => rendererCount(fixture) >= 1, child, 'initial complete publication');
  assert.equal(readFileSync(path.join(fixture.directory, 'acquisitions.txt'), 'utf8'), '1');

  writeFileSync(path.join(out, 'application-only.js'), 'app edit\n');
  await waitFor(() => rendererCount(fixture) >= 2, child, 'app-only publication');
  assert.equal(readFileSync(path.join(fixture.directory, 'acquisitions.txt'), 'utf8'), '1', 'app-only watch rebuild reuses its immutable runtime');

  const publishedBeforeInvalid = rendererCount(fixture);
  const originalId = readFileSync(path.join(out, 'pie-build-id.txt'), 'utf8');
  writeFileSync(path.join(out, 'webview/panel/pie-build-id.txt'), 'ffffffffffffffffffff\n');
  await waitFor(() => child.stderrText.includes('Host/webview build identity mismatch'), child, 'mismatched identity rejection');
  assert.equal(rendererCount(fixture), publishedBeforeInvalid, 'a mismatched host/webview identity is never published');
  writeFileSync(path.join(out, 'webview/panel/pie-build-id.txt'), originalId);
  await waitFor(() => rendererCount(fixture) === publishedBeforeInvalid + 1, child, 'restored identity publication');

  const publishedBeforeMissing = rendererCount(fixture);
  const requiredHostFile = path.join(out, 'extension.js');
  const savedHostFile = readFileSync(requiredHostFile);
  unlinkSync(requiredHostFile);
  await waitFor(() => child.stderrText.includes('ENOENT'), child, 'incomplete bundle rejection');
  assert.equal(rendererCount(fixture), publishedBeforeMissing, 'publication also requires the complete coordinated output set');
  writeFileSync(requiredHostFile, savedHostFile);
  await waitFor(() => rendererCount(fixture) === publishedBeforeMissing + 1, child, 'complete output publication');

  const beforeRotation = rendererCount(fixture);
  writeFileSync(fixture.fingerprintFile, 'source-v2\n');
  await waitFor(() => events(fixture).some(item => item.event === 'acquire-start' && item.count === 2), child, 'fresh acquisition after source edit');
  const startsBefore = events(fixture).filter(item => item.event === 'child-start' && item.watch);
  assert.equal(startsBefore.length, 3, 'the stale watch selection launched no children during rotation');
  const secondStart = events(fixture).find(item => item.event === 'acquire-start' && item.count === 2);
  assert.ok(startsBefore.every(item => secondStart.drainedChildPids.includes(item.pid)), 'all previous children closed before fresh acquisition');
  assert.equal(secondStart.previousArtifactExists, false, 'the prior owned artifact was removed after child teardown');

  writeFileSync(fixture.fingerprintFile, 'source-v3-during-acquisition\n');
  writeFileSync(path.join(fixture.controls, 'release-2'), 'release');
  await waitFor(() => events(fixture).some(item => item.event === 'acquire-start' && item.count === 3), child, 'second source change rotates acquisition again');
  assert.equal(rendererCount(fixture), beforeRotation, 'a source change during acquisition publishes no stale selection');
  const thirdStart = events(fixture).find(item => item.event === 'acquire-start' && item.count === 3);
  assert.equal(thirdStart.previousArtifactExists, false, 'the acquisition that overlapped a source edit is cleaned before retry');
  await waitFor(() => events(fixture).filter(item => item.event === 'child-start' && item.watch).length === 6, child, 'stable fresh selection starts watchers');
  assert.equal(rendererCount(fixture), beforeRotation, 'publication resumes only after the stable source acquisition');
  await waitFor(() => rendererCount(fixture) === beforeRotation + 1, child, 'stable fresh selection publication');

  const records = events(fixture);
  const acquired = records.filter(item => item.event === 'acquire-complete');
  const runtimePublications = records.filter(item => item.event === 'runtime-publication');
  const rendererPublications = records.filter(item => item.event === 'renderer-publication');
  assert.equal(acquired.length, 3);
  assert.equal(runtimePublications.length, rendererPublications.length);
  assert.ok(runtimePublications.every(item => item.files === 4), 'each staged artifact passed the fake complete-payload verifier');
  assert.ok(runtimePublications.slice(0, publishedBeforeInvalid + 2).every(item => item.identity === acquired[0].identity),
    'app-only publications reuse the selected runtime identity');
  assert.equal(runtimePublications.some(item => item.identity === acquired[1].identity), false,
    'the acquisition overlapped by a source change was never published');
  assert.equal(runtimePublications.at(-1).identity, acquired[2].identity, 'publication resumes with the final stable acquisition');
  const copiedManifest = JSON.parse(readFileSync(path.join(out, 'pi-runtime/manifest.json'), 'utf8'));
  assert.equal(copiedManifest.identity, acquired[2].identity, 'the copied runtime is the verified artifact that was published');
  assert.ok(existsSync(path.join(out, 'pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js')));

  await stopWatch(child);
  assert.equal(rendererCount(fixture), beforeRotation + 1, 'only the final stable selection publishes after rotation');
});

test('watch cancellation awaits an in-flight fingerprint and never resumes publication', async (t) => {
  const fixture = makeFixture(t, { webviewFails: false });
  const child = startWatchBuild(t, fixture);
  await waitFor(() => rendererCount(fixture) >= 1, child, 'initial publication');
  // Hold the next inventory, then enqueue publication while that poll is active.
  // The fixture rejects concurrent inventories, so publication must await it.
  writeFileSync(path.join(fixture.controls, 'hold-fingerprint'), 'hold');
  await waitFor(() => events(fixture).some(item => item.event === 'fingerprint-held'), child, 'in-flight inventory');
  const published = rendererCount(fixture);
  writeFileSync(path.join(outputDir(fixture), 'app-edit.js'), 'edit');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.doesNotMatch(child.stderrText, /Concurrent fingerprint inventory/u);
  if (process.platform === 'win32') child.send('fixture:SIGTERM');
  else child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, 'shutdown waits for the running source read');
  writeFileSync(path.join(fixture.controls, 'release-fingerprint'), 'release');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, child, 'inventory and child teardown');
  assert.equal(child.exitCode, 0, `${child.stdoutText}\n${child.stderrText}`);
  assert.equal(rendererCount(fixture), published, 'cancelled polling never schedules another publication');
  assert.equal(readFileSync(path.join(fixture.directory, 'acquisitions.txt'), 'utf8'), '1');
});

for (const stage of ['polling', 'publication', 'acquisition']) {
  for (const kind of ['edit', 'delete']) {
    test(`watch retries observed source ${kind} during ${stage} after draining siblings`, async (t) => {
      const fixture = makeFixture(t, { webviewFails: false });
      const child = startWatchBuild(t, fixture);
      await waitFor(() => rendererCount(fixture) >= 1, child, 'initial publication');
      await waitFor(() => events(fixture).some(item => item.event === 'poll-complete'), child, 'initial publication settles before injection');
      const first = events(fixture).find(item => item.event === 'acquire-complete');
      const published = rendererCount(fixture);
      writeFileSync(path.join(fixture.controls, `race-${stage}-${kind}`), 'race');
      if (stage === 'acquisition') writeFileSync(fixture.fingerprintFile, 'fresh source');
      if (stage === 'publication') writeFileSync(path.join(outputDir(fixture), 'app-race.js'), 'edit');
      await waitFor(() => events(fixture).some(item => item.event === 'source-race'), child, 'injected source mutation');
      await waitFor(() => rendererCount(fixture) > published, child, 'fresh stable publication after retry');
      assert.equal(child.exitCode, null, 'watch remains live');
      const records = events(fixture);
      const latest = records.filter(item => item.event === 'acquire-complete').at(-1);
      assert.notEqual(latest.identity, first.identity);
      assert.equal(records.filter(item => item.event === 'runtime-publication').at(-1).identity, latest.identity);
      const next = records.find(item => item.event === 'acquire-start' && item.count === 2);
      const oldChildren = records.filter(item => item.event === 'child-start' && item.watch).slice(0, 3);
      assert.equal(oldChildren.length, 3);
      assert.ok(oldChildren.every(item => next.drainedChildPids.includes(item.pid)));
      assert.equal(next.previousArtifactExists, false, 'cleanup follows complete sibling teardown');
      assert.equal(rendererCount(fixture), published + 1, 'no stale or partial selection published');
      if (stage === 'acquisition') {
        assert.equal(records.filter(item => item.event === 'acquire-start').length, 3, 'failed acquisition is retried once');
      }
      await stopWatch(child);
    });
  }
}

for (const stage of ['polling', 'acquisition']) {
  for (const kind of ['permission', 'invalid']) {
    test(`watch keeps ${kind} errors terminal during ${stage}`, async (t) => {
      const fixture = makeFixture(t, { webviewFails: false });
      const child = startWatchBuild(t, fixture);
      await waitFor(() => rendererCount(fixture) >= 1, child, 'initial publication');
      await waitFor(() => events(fixture).some(item => item.event === 'poll-complete'), child, 'initial publication settles before injection');
      const published = rendererCount(fixture);
      writeFileSync(path.join(fixture.controls, `race-${stage}-${kind}`), 'fail');
      if (stage === 'acquisition') writeFileSync(fixture.fingerprintFile, 'force acquisition');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, child, 'terminal input failure');
      assert.notEqual(child.exitCode, 0);
      assert.match(child.stderrText, kind === 'permission' ? /fixture permission denied/ : /Generated source inventory entry/);
      assert.equal(rendererCount(fixture), published);
      assert.equal(events(fixture).filter(item => item.event === 'source-race').length, 1);
    });
  }
}

test('watch acquisition verification failures remain terminal', async (t) => {
  const fixture = makeFixture(t, { webviewFails: false });
  writeFileSync(path.join(fixture.controls, 'invalid-artifact'), 'corrupt');
  const child = startWatchBuild(t, fixture);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, child, 'verification failure');
  assert.notEqual(child.exitCode, 0);
  assert.match(child.stderrText, /Invalid fixture runtime: incomplete or changed payload/);
  assert.equal(events(fixture).filter(item => item.event === 'acquire-start').length, 1);
  assert.equal(rendererCount(fixture), 0);
});

test('watch cancellation interrupts the source-instability retry delay', async (t) => {
  const fixture = makeFixture(t, { webviewFails: false });
  const child = startWatchBuild(t, fixture);
  await waitFor(() => rendererCount(fixture) >= 1, child, 'initial publication');
  writeFileSync(path.join(fixture.controls, 'race-acquisition-edit'), 'race');
  writeFileSync(fixture.fingerprintFile, 'force acquisition');
  await waitFor(() => events(fixture).some(item => item.event === 'source-race'), child, 'acquisition retry delay');
  const started = Date.now();
  await stopWatch(child);
  assert.ok(Date.now() - started < 900, 'cancellation does not wait for the one-second retry delay');
  assert.equal(events(fixture).filter(item => item.event === 'acquire-start').length, 2);
});

test('explicitly pinned watch ignores mutable source fingerprints', async (t) => {
  const fixture = makeFixture(t, { webviewFails: false });
  const pinned = path.join(fixture.directory, 'pinned-runtime');
  await makePinnedArtifact(fixture, pinned);
  const child = startWatchBuild(t, fixture, ['--watch', '--pi-runtime', pinned, '--no-sync']);
  await waitFor(() => events(fixture).filter(item => item.event === 'child-start' && item.watch).length === 3, child, 'pinned watchers start');
  assert.match(child.stdoutText, /explicitly pinned/u);
  assert.equal(existsSync(path.join(fixture.directory, 'acquisitions.txt')), false, 'an explicit artifact is reused, never reacquired');

  writeFileSync(fixture.fingerprintFile, 'mutable-source-changed\n');
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(events(fixture).filter(item => item.event === 'child-start' && item.watch).length, 3, 'source edits do not rotate a pinned selection');
  assert.equal(existsSync(pinned), true, 'the caller-owned pinned artifact is never removed');
  await stopWatch(child);
});
