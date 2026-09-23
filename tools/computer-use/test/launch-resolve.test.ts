import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLaunchExecutable } from '../src/launch-resolve.mjs';

function deps(existing: string[], shortcuts: [string, string][], env: Record<string, string>) {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const existingSet = new Set(existing.map(norm));
  const shortcutMap = new Map(shortcuts);
  return {
    env,
    access: async (p: string) => { if (!existingSet.has(norm(p))) { const e = new Error('ENOENT'); (e as any).code = 'ENOENT'; throw e; } },
    realpath: async (p: string) => { if (!existingSet.has(norm(p))) { const e = new Error('ENOENT'); (e as any).code = 'ENOENT'; throw e; } return p; },
    execFile: async (_cmd: string, args: string[]) => {
      const script = args.at(-1) ?? '';
      for (const [link, target] of shortcutMap) { if (script.includes(link)) return { stdout: target }; }
      return { stdout: '' };
    },
  };
}

test('bare executable name resolves via PATH to a native .exe', async () => {
  const d = deps(['C:\\bin\\editor.exe'], [], { PATH: 'C:\\bin;C:\\other', PATHEXT: '.EXE;.BAT;.CMD' });
  const result = (await resolveLaunchExecutable('editor', d)).toLowerCase();
  assert.ok(result.endsWith('editor.exe'));
  assert.ok(result.includes('bin'));
});

test('bare name with extension resolves via PATH', async () => {
  const d = deps(['C:\\bin\\editor.exe'], [], { PATH: 'C:\\bin', PATHEXT: '.EXE' });
  const result = (await resolveLaunchExecutable('editor.exe', d)).toLowerCase();
  assert.ok(result.endsWith('editor.exe'));
});

test('bare name not on PATH emits an actionable LAUNCH_UNRESOLVED error', async () => {
  const d = deps([], [], { PATH: 'C:\\bin', PATHEXT: '.EXE' });
  await assert.rejects(() => resolveLaunchExecutable('missing', d), (e: any) => e.code === 'LAUNCH_UNRESOLVED' && /PATH/.test(e.message));
});

test('absolute .exe path is returned resolved', async () => {
  const d = deps(['C:\\apps\\godot.exe'], [], { PATH: '', PATHEXT: '.EXE' });
  const result = await resolveLaunchExecutable('C:\\apps\\godot.exe', d);
  assert.ok(result.endsWith('godot.exe'));
});

test('.lnk shortcut resolves to its target .exe', async () => {
  const d = deps(['C:\\shortcuts\\godot.lnk', 'C:\\apps\\godot.exe'], [['C:\\shortcuts\\godot.lnk', 'C:\\apps\\godot.exe']], { PATH: '', PATHEXT: '.EXE' });
  const result = await resolveLaunchExecutable('C:\\shortcuts\\godot.lnk', d);
  assert.ok(result.endsWith('godot.exe'));
});

test('.lnk without a target emits LAUNCH_UNRESOLVED', async () => {
  const d = deps(['C:\\shortcuts\\empty.lnk'], [['C:\\shortcuts\\empty.lnk', '']], { PATH: '', PATHEXT: '.EXE' });
  await assert.rejects(() => resolveLaunchExecutable('C:\\shortcuts\\empty.lnk', d), (e: any) => e.code === 'LAUNCH_UNRESOLVED' && /Shortcut/.test(e.message));
});

test('bare name skips a same-name shell wrapper when a safe executable is available', async () => {
  const d = deps(['C:\\bin\\godot.bat', 'C:\\bin\\godot.exe'], [], { PATH: 'C:\\bin', PATHEXT: '.BAT;.EXE' });
  const result = await resolveLaunchExecutable('godot', d);
  assert.ok(result.toLowerCase().endsWith('godot.exe'));
});

test('shell wrapper (.bat) emits an actionable LAUNCH_UNRESOLVED without launching', async () => {
  const d = deps(['C:\\bin\\godot.bat'], [], { PATH: 'C:\\bin', PATHEXT: '.EXE;.BAT' });
  await assert.rejects(() => resolveLaunchExecutable('godot', d), (e: any) => e.code === 'LAUNCH_UNRESOLVED' && /native executable/i.test(e.message));
});

test('nonexistent path emits LAUNCH_UNRESOLVED', async () => {
  const d = deps([], [], { PATH: '', PATHEXT: '.EXE' });
  await assert.rejects(() => resolveLaunchExecutable('C:\\nope\\godot.exe', d), (e: any) => e.code === 'LAUNCH_UNRESOLVED');
});

test('.lnk chain resolves through nested shortcuts to a native .exe', async () => {
  const d = deps(['C:\\a.lnk', 'C:\\b.lnk', 'C:\\app.exe'], [['C:\\a.lnk', 'C:\\b.lnk'], ['C:\\b.lnk', 'C:\\app.exe']], { PATH: '', PATHEXT: '.EXE' });
  const result = await resolveLaunchExecutable('C:\\a.lnk', d);
  assert.ok(result.endsWith('app.exe'));
});

test('a circular shortcut chain emits LAUNCH_UNRESOLVED instead of looping', async () => {
  const d = deps(['C:\\a.lnk', 'C:\\b.lnk'], [['C:\\a.lnk', 'C:\\b.lnk'], ['C:\\b.lnk', 'C:\\a.lnk']], { PATH: '', PATHEXT: '.EXE' });
  await assert.rejects(() => resolveLaunchExecutable('C:\\a.lnk', d), (e: any) => e.code === 'LAUNCH_UNRESOLVED');
});

test('empty input emits LAUNCH_UNRESOLVED', async () => {
  const d = deps([], [], { PATH: '', PATHEXT: '.EXE' });
  await assert.rejects(() => resolveLaunchExecutable('', d), (e: any) => e.code === 'LAUNCH_UNRESOLVED');
});
