// Stubs the `vscode` module for unit tests that import host modules which use
// the VS Code API at runtime (e.g. `handlers/session.ts` → `vscode.env`).
// The real `vscode` package is only available inside the extension host; under
// `tsx --test` it is not installed, so a value-only stub suffices for the code
// paths exercised here (the recorder test never touches the stubbed values).
//
// Import this helper BEFORE importing any module that uses `vscode` at runtime.
// Node runs test files in isolated processes, so this global patch is scoped to
// the importing test file.
/* eslint-disable @typescript-eslint/no-explicit-any */
import Module from 'node:module';

const vscodeStub: any = {
  env: {
    appName: 'pi-test',
    language: 'en',
  },
  workspace: {
    name: 'pi-test-workspace',
    workspaceFolders: undefined,
  },
  window: {},
  commands: {},
};

// `Module._load` is an internal CJS loader hook not exposed on the public
// types, so cast to access it. tsx transpiles .ts through Node's CJS loader, so
// intercepting `_load` (which runs before `_resolveFilename`) lets us short-
// circuit the `vscode` bare specifier without a resolvable package on disk.
type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
const ModuleInternals = Module as unknown as { _load: ModuleLoad };
const originalLoad: ModuleLoad = ModuleInternals._load;
ModuleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};
