export const SDK_SESSION_OPEN_SINGLE_READ_PATCH_VERSION = 1 as const;

export type SdkSessionOpenTransformResult =
  | 'patched'
  | 'already-present'
  | 'unsupported-shape';

const CONSTRUCTOR_SIGNATURE_NEEDLE =
  '    constructor(cwd, sessionDir, sessionFile, persist, newSessionOptions) {';
const CONSTRUCTOR_SIGNATURE_REPLACEMENT =
  '    constructor(cwd, sessionDir, sessionFile, persist, newSessionOptions, preloadedEntries) {';
const CONSTRUCTOR_OPEN_NEEDLE = '            this.setSessionFile(sessionFile);';
const CONSTRUCTOR_OPEN_REPLACEMENT =
  '            this.setSessionFile(sessionFile, preloadedEntries);';
const SET_SESSION_FILE_SIGNATURE_NEEDLE = '    setSessionFile(sessionFile) {';
const SET_SESSION_FILE_SIGNATURE_REPLACEMENT =
  '    setSessionFile(sessionFile, preloadedEntries) {';
const SET_SESSION_FILE_LOAD_NEEDLE =
  '            this.fileEntries = loadEntriesFromFile(this.sessionFile);';
const SET_SESSION_FILE_LOAD_REPLACEMENT =
  '            this.fileEntries = preloadedEntries ?? loadEntriesFromFile(this.sessionFile);';
const STATIC_OPEN_NEEDLE =
  '        return new SessionManager(cwd, dir, resolvedPath, true);';
const STATIC_OPEN_REPLACEMENT =
  '        return new SessionManager(cwd, dir, resolvedPath, true, undefined, entries);';

const SESSION_OPEN_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [CONSTRUCTOR_SIGNATURE_NEEDLE, CONSTRUCTOR_SIGNATURE_REPLACEMENT],
  [CONSTRUCTOR_OPEN_NEEDLE, CONSTRUCTOR_OPEN_REPLACEMENT],
  [SET_SESSION_FILE_SIGNATURE_NEEDLE, SET_SESSION_FILE_SIGNATURE_REPLACEMENT],
  [SET_SESSION_FILE_LOAD_NEEDLE, SET_SESSION_FILE_LOAD_REPLACEMENT],
  [STATIC_OPEN_NEEDLE, STATIC_OPEN_REPLACEMENT],
];

export const SDK_SESSION_OPEN_SINGLE_READ_MARKERS = [
  CONSTRUCTOR_SIGNATURE_REPLACEMENT,
  CONSTRUCTOR_OPEN_REPLACEMENT,
  SET_SESSION_FILE_SIGNATURE_REPLACEMENT,
  SET_SESSION_FILE_LOAD_REPLACEMENT,
  STATIC_OPEN_REPLACEMENT,
] as const;

function hasAll(source: string, markers: readonly string[]): boolean {
  return markers.every((marker) => source.includes(marker));
}

function replaceExactlyOnce(
  source: string,
  needle: string,
  replacement: string,
): string | undefined {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) return undefined;
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function applyForwardReplacements(source: string): string | undefined {
  let transformed = source;
  for (const [needle, replacement] of SESSION_OPEN_REPLACEMENTS) {
    const next = replaceExactlyOnce(transformed, needle, replacement);
    if (next === undefined) return undefined;
    transformed = next;
  }
  return transformed;
}

/**
 * Reverse the exact single-read transform. The patch barrier hashes the result
 * against the pinned pristine SDK, so marker-preserving edits still fail closed.
 */
export function reverseSdkSessionOpenSingleRead(source: string): string | undefined {
  if (!hasAll(source, SDK_SESSION_OPEN_SINGLE_READ_MARKERS)) return undefined;
  let reversed = source;
  for (const [needle, replacement] of [...SESSION_OPEN_REPLACEMENTS].reverse()) {
    const next = replaceExactlyOnce(reversed, replacement, needle);
    if (next === undefined) return undefined;
    reversed = next;
  }
  return reversed;
}

/**
 * Thread the entries already parsed by SessionManager.open() through the private
 * constructor into setSessionFile(). The latter remains the sole owner of empty
 * and invalid-file handling, migrations, rewrites, index construction, and
 * flushed state; only its redundant second loadEntriesFromFile() call is skipped.
 */
export function transformSdkSessionOpenSingleRead(source: string): {
  result: SdkSessionOpenTransformResult;
  source: string;
} {
  if (hasAll(source, SDK_SESSION_OPEN_SINGLE_READ_MARKERS)) {
    return { result: 'already-present', source };
  }
  if (SDK_SESSION_OPEN_SINGLE_READ_MARKERS.some((marker) => source.includes(marker))) {
    return { result: 'unsupported-shape', source };
  }
  const transformed = applyForwardReplacements(source);
  return transformed && hasAll(transformed, SDK_SESSION_OPEN_SINGLE_READ_MARKERS)
    ? { result: 'patched', source: transformed }
    : { result: 'unsupported-shape', source };
}

export function hasSdkSessionOpenSingleReadMarkers(source: string): boolean {
  return hasAll(source, SDK_SESSION_OPEN_SINGLE_READ_MARKERS);
}
