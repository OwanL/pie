import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateAuthDirectory } from '../lib/auth-directory.mjs';

test('auth directory validation checks canonical checkout boundaries without creating paths', () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-auth-directory-'));
  try {
    const repoRoot = path.join(fixtureRoot, 'checkout');
    const nestedRepoDir = path.join(repoRoot, 'nested', 'auth');
    const externalDir = path.join(fixtureRoot, 'external');
    mkdirSync(nestedRepoDir, { recursive: true });
    mkdirSync(externalDir);

    const validate = (authDir) => validateAuthDirectory({ repoRoot, authDir });
    assert.equal(validate(repoRoot).valid, false, 'checkout root is rejected');
    assert.equal(validate(nestedRepoDir).valid, false, 'nested checkout directory is rejected');
    assert.equal(validate('relative-auth-dir').valid, false, 'relative auth paths are rejected');
    assert.equal(validate(externalDir).valid, true, 'an existing external directory is allowed');

    const newExternalDir = path.join(externalDir, 'not-created', 'yet');
    assert.equal(validate(newExternalDir).valid, true, 'a new external directory is allowed');
    assert.equal(existsSync(newExternalDir), false, 'validation does not create the external directory');

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const checkoutAlias = path.join(fixtureRoot, 'checkout-alias');
    symlinkSync(repoRoot, checkoutAlias, linkType);
    assert.equal(validate(checkoutAlias).valid, false, 'an external junction resolving into the checkout is rejected');
    assert.equal(validate(path.join(checkoutAlias, 'new-auth-dir')).valid, false,
      'a missing auth directory below a checkout junction is rejected via its canonical ancestor');
    assert.equal(validateAuthDirectory({ repoRoot: checkoutAlias, authDir: repoRoot }).valid, false,
      'the checkout root is canonicalized even when its configured path is a junction');

    const futureCheckoutTarget = path.join(repoRoot, 'future-session-store');
    const danglingAlias = path.join(fixtureRoot, 'dangling-checkout-alias');
    symlinkSync(futureCheckoutTarget, danglingAlias, linkType);
    assert.equal(validate(danglingAlias).valid, false, 'an alias with an unresolved target is not treated as a missing directory');
    assert.equal(validate(path.join(danglingAlias, 'auth')).valid, false, 'missing tails below a broken alias remain rejected');
    assert.equal(existsSync(futureCheckoutTarget), false, 'validation does not create the alias target');
    mkdirSync(futureCheckoutTarget);
    assert.equal(validate(danglingAlias).valid, false, 'the alias remains rejected when an installer step creates its in-checkout target');

    const externalAlias = path.join(fixtureRoot, 'external-alias');
    symlinkSync(externalDir, externalAlias, linkType);
    assert.equal(validate(externalAlias).valid, true, 'an external junction resolving outside the checkout is allowed');
    assert.equal(validate(path.join(externalAlias, 'new-auth-dir')).valid, true,
      'a missing external auth directory below an external junction is allowed');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
