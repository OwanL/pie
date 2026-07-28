#!/usr/bin/env node

import { constants, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function repoRoot() {
  return path.resolve(fileURLToPath(import.meta.url), '..', '..');
}

/**
 * Seed the Pi settings file when it is missing (for example, a checkout where
 * settings.json was deleted). Existing settings are never merged or rewritten:
 * this is a no-op when the file is already present. Note that `sync-models`
 * separately regenerates the model-owned fields of settings.json, while chat
 * and pruning selections remain user-owned.
 */
export function ensureSettings(root = repoRoot()) {
  const settingsPath = path.join(root, 'settings.json');
  if (existsSync(settingsPath)) return { created: false, settingsPath };

  const defaultsPath = path.join(root, 'settings.defaults.json');
  if (!existsSync(defaultsPath)) {
    throw new Error(`Cannot create ${settingsPath}: defaults file not found at ${defaultsPath}`);
  }

  copyFileSync(defaultsPath, settingsPath, constants.COPYFILE_EXCL);
  return { created: true, settingsPath };
}

function isMain() {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMain()) {
  const result = ensureSettings();
  console.log(result.created
    ? `Created settings.json from settings.defaults.json.`
    : `settings.json already exists; left unchanged.`);
}
