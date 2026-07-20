#!/usr/bin/env node

import { constants, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function repoRoot() {
  return path.resolve(fileURLToPath(import.meta.url), '..', '..');
}

/**
 * Seed the machine-local Pi settings file on first use. Existing settings are
 * never merged or rewritten: after creation, settings.json belongs entirely to
 * the machine on which it lives.
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
    ? `Created machine-local settings.json from settings.defaults.json.`
    : `Machine-local settings.json already exists; left unchanged.`);
}
