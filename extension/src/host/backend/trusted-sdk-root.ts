import * as path from 'node:path';

export function deriveTrustedSdkRoot(sdkPath: string): string | undefined {
  const resolved = path.resolve(sdkPath);
  const parts = resolved.split(path.sep);
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0) return undefined;
  return parts.slice(0, nodeModulesIndex + 1).join(path.sep) || path.parse(resolved).root;
}