import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorProviderNetworkLeaseAuthority } from '../coordinator-provider-network-lease.js';
import { ProviderGate } from '../provider-gate.js';

const owner = { coordinatorGeneration: 1, workerId: 'removal', workerGeneration: 1 };

test('live removal rejects queued/new coordinator admissions without revoking delivered work; re-add works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pie-removal-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  const save = (removed: boolean) => writeFileSync(join(dir, 'providers.yaml'), JSON.stringify({ version: 1, providers: { p: removed ? { enabled: false, removed: true } : { enabled: true } } }));
  const authority = new CoordinatorProviderNetworkLeaseAuthority({ defaultPolicy: { queueWaitMs: 1000 } });
  try {
    save(false);
    const active = await authority.acquire(owner, 'active', { provider: 'p', model: 'm' });
    authority.markDelivered(owner, 'active', active.leaseId);
    const queued = authority.acquire(owner, 'queued', { provider: 'p', model: 'm' });
    save(true);
    const rejected = (error: any) => error.name === 'ProviderRemovedError' && error.isRetryable === false;
    await assert.rejects(queued, rejected);
    await assert.rejects(authority.acquire(owner, 'new', { provider: 'p', model: 'm' }), rejected);
    assert.equal(authority.isActive(owner, 'active', active.leaseId), true);
    assert.equal(authority.getMetrics()[0].strikeCount, 0);
    authority.release(owner, active.leaseId, 'completed');
    save(false);
    const next = await authority.acquire(owner, 'again', { provider: 'p', model: 'm' });
    const drain = authority.acquire(owner, 'drain', { provider: 'p', model: 'm' });
    save(true);
    authority.release(owner, next.leaseId, 'completed');
    await assert.rejects(drain, rejected);
    assert.equal(authority.getMetrics()[0].strikeCount, 0);
  } finally {
    authority.releaseOwner(owner);
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy gate blocks removal after queue wait without sending upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pie-gate-removal-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  const fetch = globalThis.fetch;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  const save = (removed: boolean) => writeFileSync(join(dir, 'providers.yaml'), JSON.stringify({ version: 1, providers: { p: removed ? { enabled: false, removed: true } : { enabled: true } } }));
  let calls = 0;
  let finish!: () => void;
  globalThis.fetch = (async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); return new Response(null); }) as typeof fetch;
  try {
    save(false);
    ProviderGate.install([{ provider: 'p', baseUrl: 'https://removal.test', maxConcurrentRequests: 1, afterburnSeconds: 0, queueWaitSeconds: 1 }], 0);
    const first = globalThis.fetch('https://removal.test/chat');
    await new Promise(resolve => setTimeout(resolve, 0));
    const queued = globalThis.fetch('https://removal.test/chat');
    save(true);
    await assert.rejects(queued, (error: any) => error.name === 'ProviderRemovedError' && error.isRetryable === false);
    assert.equal(calls, 1);
    save(false);
    const draining = globalThis.fetch('https://removal.test/chat');
    save(true);
    finish();
    await first;
    await assert.rejects(draining, { name: 'ProviderRemovedError' });
    assert.equal(calls, 1, 'post-wait fence blocks a queue drained before the next removal poll');
    await assert.rejects(globalThis.fetch('https://removal.test/chat'), { name: 'ProviderRemovedError' });
  } finally {
    ProviderGate.uninstall();
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
