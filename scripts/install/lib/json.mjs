// Shared JSON helpers for the pie installers.
//
// Both install.ps1 and install.sh manipulate JSON config files (settings.json,
// auth.json, VS Code User settings). PowerShell's default encoders can emit a
// UTF-8 BOM and use ConvertTo-Json formatting; Node's fs always writes BOM-less
// UTF-8. Routing every installer JSON read/write through these helpers gives
// both platforms identical, BOM-less, 2-space-indented output so re-running the
// installer is idempotent (a second run produces no diff).
//
// These functions are intentionally pure / side-effect-free except for the
// explicit fs calls in readJsonFile/writeJsonFile, so they can be unit-tested
// against temp directories without touching real user configuration.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Parse a JSON string, returning `fallback` when the string is empty or
 * malformed. Mirrors the installer behaviour of degrading to an empty object
 * for unreadable config rather than aborting the whole bootstrap.
 * @param {string} text
 * @param {unknown} [fallback] - returned for empty/invalid input (default null)
 * @returns {unknown}
 */
export function parseJson(text, fallback = null) {
  if (text == null || String(text).trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Read and parse a JSON file.
 * - Missing file -> `fallback` (installers treat a absent config as empty).
 * - Unparseable file -> `fallback` (matches Read-AuthJson / VS Code settings
 *   try/catch fallbacks). Callers that want a hard error on corruption can pass
 *   `throwOnParseError: true`.
 * @param {string} filePath
 * @param {{ fallback?: unknown, throwOnParseError?: boolean }} [options]
 * @returns {unknown}
 */
export function readJsonFile(filePath, { fallback = null, throwOnParseError = false } = {}) {
  if (!existsSync(filePath)) return fallback;
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
  if (text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (throwOnParseError) throw error;
    return fallback;
  }
}

/**
 * Serialize a value as 2-space-indented JSON.
 * @param {unknown} data
 * @param {{ indent?: number, trailingNewline?: boolean }} [options]
 * @returns {string}
 */
export function stringifyJson(data, { indent = 2, trailingNewline = false } = {}) {
  const text = JSON.stringify(data, null, indent);
  return trailingNewline ? `${text}\n` : text;
}

/**
 * Write JSON to a file as BOM-less UTF-8 with 2-space indentation.
 * `trailingNewline` defaults to false to match the git-tracked settings.json
 * style (no trailing newline); user-owned files (auth.json, VS Code User
 * settings) opt in via `trailingNewline: true`.
 * @param {string} filePath
 * @param {unknown} data
 * @param {{ indent?: number, trailingNewline?: boolean }} [options]
 * @returns {string} the text that was written (for caller logging / idempotency)
 */
export function writeJsonFile(filePath, data, { indent = 2, trailingNewline = false } = {}) {
  const text = stringifyJson(data, { indent, trailingNewline });
  writeFileSync(filePath, text, 'utf8');
  return text;
}
