import { createRequire } from 'node:module';

// Native runtime packages remain installed and locked by extensions/computer-use.
export const requireComputerUseDependency = createRequire(new URL('../../extensions/computer-use/package.json', import.meta.url));
export const cuaDriverEntry = new URL('../../extensions/computer-use/node_modules/@trycua/cua-driver/dist/index.js', import.meta.url);
