import { spawnSync } from "node:child_process";

const nodeManagerSegments = new Map([
  [".nvm", "nvm"],
  ["nvm", "nvm"],
  ["nvm-windows", "nvm"],
  ["nvm4w", "nvm"],
  ["fnm", "fnm"],
  ["fnm_multishells", "fnm"],
  [".volta", "volta"],
  ["volta", "volta"],
  ["nvs", "nvs"],
  ["nodenv", "nodenv"],
  ["proto", "proto"],
  ["asdf", "asdf"],
  ["mise", "mise"],
]);

// A "direct versioned Node directory" is a PATH entry that resolves to a
// versioned Node install — the nvm-windows `v20.11.0` convention, a bare
// `20.11.0`, or an extracted `node-v20.11.0[-win-x64]` archive. PATH commonly
// points at the `bin` subdir, so a `bin` leaf whose parent is version-named
// also counts. The standard `C:/Program Files/nodejs` install (leaf `nodejs`,
// no version) is intentionally excluded so it never reads as a collision.
const VERSIONED_NODE_DIRECTORY = /^(node-)?v?\d+\.\d+\.\d+/;

function isVersionedNodeDirectory(entry) {
  const segments = normalizePathEntry(entry).split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const leaf = segments[segments.length - 1];
  const versionIndex = leaf === "bin" ? segments.length - 2 : segments.length - 1;
  const versionSegment = segments[versionIndex];
  if (!versionSegment || !VERSIONED_NODE_DIRECTORY.test(versionSegment)) return false;

  // A bare semantic-version directory is not enough evidence: Proto and other
  // managers also put Python/other SDK versions on PATH. Require Node context
  // either in the version segment itself, an adjacent `node`/`nodejs` segment,
  // or a manager dedicated to Node installations.
  if (/^node-/i.test(versionSegment)) return true;
  const context = segments.slice(0, versionIndex);
  if (context.some((segment) => segment === "node" || segment === "nodejs")) return true;
  return context.some((segment) => [".nvm", "nvm", "nvm-windows", "nvm4w", "fnm", "fnm_multishells", "nvs", "nodenv"].includes(segment));
}

function outputLines(result) {
  if (result?.status !== 0) return [];
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizePathEntry(entry) {
  return entry.trim().replace(/^"|"$/g, "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function nodeManagerForPathEntry(entry) {
  const segments = normalizePathEntry(entry).split("/");
  return segments.map((segment) => nodeManagerSegments.get(segment)).find(Boolean);
}

function runDiagnosticCommand(spawn, command, args) {
  try {
    return spawn(command, args, { encoding: "utf8", windowsHide: true });
  } catch {
    return undefined;
  }
}

export function resolveExecutable(name, { platform = process.platform, spawn = spawnSync } = {}) {
  // `which -a` and `where.exe` both list every match on PATH so the doctor
  // surfaces the real collision instead of only the first resolved executable.
  const command = platform === "win32" ? "where.exe" : "which";
  const args = platform === "win32" ? [name] : ["-a", name];
  const result = runDiagnosticCommand(spawn, command, args);
  return { name, paths: outputLines(result) };
}

export function findNodeManagerPathWarnings(pathValue, { platform = process.platform } = {}) {
  const delimiter = platform === "win32" ? ";" : ":";
  const seenEntries = new Set();
  const managers = new Set();
  const versionedDirs = new Map();
  const warnings = [];

  for (const entry of (pathValue ?? "").split(delimiter).map((value) => value.trim()).filter(Boolean)) {
    const normalized = normalizePathEntry(entry);

    if (isVersionedNodeDirectory(entry)) {
      if (!versionedDirs.has(normalized)) versionedDirs.set(normalized, entry);
    }

    const manager = nodeManagerForPathEntry(entry);
    if (!manager) continue;

    if (seenEntries.has(normalized)) {
      warnings.push(`duplicate Node-manager PATH entry: ${entry}`);
      continue;
    }
    seenEntries.add(normalized);
    managers.add(manager);
  }

  if (versionedDirs.size > 1) {
    warnings.push(`multiple versioned Node directories on PATH: ${[...versionedDirs.values()].join(", ")}`);
  }
  if (managers.size > 1) {
    warnings.push(`conflicting Node managers on PATH: ${[...managers].join(", ")}`);
  }
  return warnings;
}

export function readEncodingInfo({ platform = process.platform, env = process.env, spawn = spawnSync } = {}) {
  // `capturedOutputDecoding` is the invariant: spawnSync is always called with
  // `encoding: "utf8"`, so Node decodes the captured child output as UTF-8
  // regardless of the host's actual locale or console code page. It is reported
  // separately from the host-side LANG/LC_ALL (POSIX) and Windows cmd code page
  // so the doctor never implies the host encoding itself is UTF-8.
  if (platform === "win32") {
    // Invoke `chcp.com` directly rather than the cmd.exe `chcp` built-in
    // spelling so the probe resolves to the real executable unambiguously.
    const result = runDiagnosticCommand(spawn, "chcp.com", []);
    const codePage = outputLines(result).join(" ").match(/\b\d{3,5}\b/)?.[0];
    return { capturedOutputDecoding: "UTF-8", codePage: codePage ?? "unavailable" };
  }

  return { capturedOutputDecoding: "UTF-8", locale: env.LC_ALL || env.LANG || "unset" };
}

export function collectEnvironmentDiagnostics({
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
  executables = ["node", "npm", "pi", "bash", "git", "rg", "find", "jq"],
} = {}) {
  return {
    executables: executables.map((name) => resolveExecutable(name, { platform, spawn })),
    encoding: readEncodingInfo({ platform, env, spawn }),
    pathWarnings: findNodeManagerPathWarnings(env.PATH, { platform }),
  };
}
