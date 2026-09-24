import { pathToFileURL } from 'node:url';

import { createNativeOwnerRequire, resolveNativeOwnerPath } from '../../scripts/lib/native-owner.mjs';

// Native runtime packages remain installed and locked by extensions/computer-use.
export const requireComputerUseDependency = createNativeOwnerRequire('computer-use');
export const cuaDriverEntry = pathToFileURL(resolveNativeOwnerPath('computer-use', [
  'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js',
]));
