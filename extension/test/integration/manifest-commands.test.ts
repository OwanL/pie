import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('package manifest exposes the export run analytics command for keybindings and automation', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{ command?: string }>;
      configuration?: { properties?: Record<string, { type?: string; default?: unknown; description?: string }> };
    };
  };

  const commands = manifest.contributes?.commands?.map((entry) => entry.command) ?? [];
  assert.ok(commands.includes('pie.exportRunAnalytics'));
  assert.ok(manifest.activationEvents?.includes('onCommand:pie.exportRunAnalytics'));
});

test('trusted-LAN browser-server setting is explicit and off by default', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    contributes?: {
      configuration?: { properties?: Record<string, { type?: string; default?: unknown; description?: string; scope?: string }> };
    };
  };
  const setting = manifest.contributes?.configuration?.properties?.['pie.browserServer.allowLan'];
  assert.equal(setting?.type, 'boolean');
  assert.equal(setting?.default, false);
  assert.equal(setting?.scope, 'application');
  assert.match(setting?.description ?? '', /execute commands and read or modify files/i);
});

test('browser-server automatic-start setting is application-scoped and documents the popover switch', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    contributes?: {
      configuration?: { properties?: Record<string, { type?: string; default?: unknown; description?: string; scope?: string }> };
    };
  };
  const setting = manifest.contributes?.configuration?.properties?.['pie.browserServer.enabled'];
  assert.equal(setting?.type, 'boolean');
  assert.equal(setting?.default, true);
  // Machine-wide authority like allowLan: the global value owns the one
  // shared listener, so workspace overrides would be misleading.
  assert.equal(setting?.scope, 'application');
  assert.match(setting?.description ?? '', /Browser network access popover/);
});
