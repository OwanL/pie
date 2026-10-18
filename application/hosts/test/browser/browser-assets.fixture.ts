import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';

/** Shared panel/lazy-chunk cycle; callers add only their suite-specific assets. */
export async function createBrowserAssetDir(t: TestContext, stopServer?: () => Promise<void>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-browser-assets-'));
  t.after(async () => {
    // Never remove files while a server may still be serving them.
    await stopServer?.();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dir, '.vite'));
  await fs.mkdir(path.join(dir, 'assets'));
  await fs.writeFile(path.join(dir, 'assets', 'panel-abc123.js'), 'console.log("pie");\n');
  await fs.writeFile(path.join(dir, 'assets', 'panel-abc123.css'), 'body {}\n');
  await fs.writeFile(path.join(dir, 'assets', 'transcript-host-xyz789.js'), 'export {};\n');
  await fs.writeFile(path.join(dir, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': {
      file: 'assets/panel-abc123.js',
      isEntry: true,
      css: ['assets/panel-abc123.css'],
      // Mirrors the real panel: the transcript host is lazy-loaded.
      dynamicImports: ['transcript-host.tsx'],
    },
    'transcript-host.tsx': {
      file: 'assets/transcript-host-xyz789.js',
      isDynamicEntry: true,
      imports: ['index.html'],
    },
  }));
  return dir;
}
