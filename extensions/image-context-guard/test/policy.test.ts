import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FAIL_SAFE_MAX_IMAGES_PER_REQUEST,
  buildImagePolicy,
  invalidateImagePolicyCache,
  loadImagePolicy,
  policyKey,
  resolveImagePolicy,
} from '../src/policy.js';

const catalog = {
  providers: {
    'github-copilot': {
      models: [
        { id: 'claude-sonnet-5', input: ['text', 'image'], maxImagesPerRequest: 4 },
        { id: 'gpt-5-mini', input: ['text', 'image'], maxImagesPerRequest: 1 },
        { id: 'text-only-model', input: ['text'] },
        { id: 'image-without-max', input: ['text', 'image'] },
        { id: 'image-bad-max', input: ['text', 'image'], maxImagesPerRequest: 0 },
      ],
      modelOverrides: {
        'gpt-5.6-sol': { input: ['text', 'image'], maxImagesPerRequest: 1 },
        'gpt-5.5': { input: ['text'] },
      },
    },
    ollama: {
      models: [{ id: 'gemini-flash', input: ['text', 'image'], maxImagesPerRequest: 10 }],
    },
  },
};

test('buildImagePolicy records only image-capable models with a valid positive maximum', () => {
  const policy = buildImagePolicy(catalog as any);

  assert.equal(policy.get(policyKey('github-copilot', 'claude-sonnet-5')), 4);
  assert.equal(policy.get(policyKey('github-copilot', 'gpt-5-mini')), 1);
  assert.equal(policy.get(policyKey('ollama', 'gemini-flash')), 10);
  // overrideOnly entry folded in provider-qualified.
  assert.equal(policy.get(policyKey('github-copilot', 'gpt-5.6-sol')), 1);
  // text-only and malformed entries are excluded.
  assert.equal(policy.get(policyKey('github-copilot', 'text-only-model')), undefined);
  assert.equal(policy.get(policyKey('github-copilot', 'gpt-5.5')), undefined);
  assert.equal(policy.get(policyKey('github-copilot', 'image-without-max')), undefined);
  assert.equal(policy.get(policyKey('github-copilot', 'image-bad-max')), undefined);
});

test('a duplicate id under another provider is provider-qualified and never confused', () => {
  const dup = {
    providers: {
      'github-copilot': { models: [{ id: 'shared', input: ['text', 'image'], maxImagesPerRequest: 3 }] },
      'openai-codex': { modelOverrides: { shared: { input: ['text', 'image'], maxImagesPerRequest: 1 } } },
    },
  };
  const policy = buildImagePolicy(dup as any);
  assert.equal(policy.get(policyKey('github-copilot', 'shared')), 3);
  assert.equal(policy.get(policyKey('openai-codex', 'shared')), 1);
});

test('resolveImagePolicy: text-only model projects zero images and is configured', () => {
  const policy = buildImagePolicy(catalog as any);
  const resolved = resolveImagePolicy('github-copilot', 'text-only-model', ['text'], policy);
  assert.deepEqual(resolved, { maxImagesPerRequest: 0, configured: true });
});

test('resolveImagePolicy: configured image-capable model uses the catalog maximum', () => {
  const policy = buildImagePolicy(catalog as any);
  const resolved = resolveImagePolicy('github-copilot', 'claude-sonnet-5', ['text', 'image'], policy);
  assert.deepEqual(resolved, { maxImagesPerRequest: 4, configured: true });
});

test('resolveImagePolicy: image-capable model absent from policy uses fail-safe one and is unconfigured', () => {
  const policy = buildImagePolicy(catalog as any);
  const resolved = resolveImagePolicy('github-copilot', 'brand-new-vision-model', ['text', 'image'], policy);
  assert.equal(FAIL_SAFE_MAX_IMAGES_PER_REQUEST, 1);
  assert.deepEqual(resolved, { maxImagesPerRequest: 1, configured: false });
});

test('resolveImagePolicy treats an absent input as text-only (zero, configured)', () => {
  const policy = buildImagePolicy(catalog as any);
  const resolved = resolveImagePolicy('github-copilot', 'no-input-model', undefined, policy);
  assert.deepEqual(resolved, { maxImagesPerRequest: 0, configured: true });
});

test('loadImagePolicy keys its cache by catalog path as well as mtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'image-policy-cache-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  try {
    await Promise.all([mkdir(first), mkdir(second)]);
    const firstPath = path.join(first, 'models.json');
    const secondPath = path.join(second, 'models.json');
    await writeFile(firstPath, JSON.stringify({ providers: { p: { models: [{ id: 'a', input: ['image'], maxImagesPerRequest: 2 }] } } }));
    await writeFile(secondPath, JSON.stringify({ providers: { p: { models: [{ id: 'b', input: ['image'], maxImagesPerRequest: 3 }] } } }));
    const sharedTime = new Date('2026-01-01T00:00:00Z');
    await Promise.all([utimes(firstPath, sharedTime, sharedTime), utimes(secondPath, sharedTime, sharedTime)]);

    invalidateImagePolicyCache();
    assert.equal(loadImagePolicy(first).get(policyKey('p', 'a')), 2);
    const secondPolicy = loadImagePolicy(second);
    assert.equal(secondPolicy.get(policyKey('p', 'a')), undefined);
    assert.equal(secondPolicy.get(policyKey('p', 'b')), 3);
  } finally {
    invalidateImagePolicyCache();
    await rm(root, { recursive: true, force: true });
  }
});
