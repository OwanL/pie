import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';

interface PipeFixture {
  child: ChildProcess;
  readonly output: string;
  readonly stderr: string;
  waitForOutput(needle: string, timeoutMs?: number): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  cleanup(): void;
}

const helperUrl = new URL('../host-lifetime-pipe.ts', import.meta.url).href;
const fixtureStdio = ['pipe', 'pipe', 'pipe', 'pipe'] as const;

function startFixture(source: string): PipeFixture {
  const child = spawn(process.execPath, [
    '--import=tsx',
    '--input-type=module',
    '--eval',
    `import { watchHostLifetimePipe } from ${JSON.stringify(helperUrl)};\n${source}`,
  ], {
    cwd: process.cwd(),
    stdio: [...fixtureStdio],
    windowsHide: true,
  });
  let output = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => undefined);

  return {
    child,
    get output() { return output; },
    get stderr() { return stderr; },
    waitForOutput(needle, timeoutMs = 30_000) {
      if (output.includes(needle)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          child.stdout?.off('data', checkOutput);
          child.off('close', checkClose);
          if (error) reject(error);
          else resolve();
        };
        const checkOutput = (): void => {
          if (output.includes(needle)) finish();
        };
        const checkClose = (): void => {
          finish(new Error(`Child exited before writing ${JSON.stringify(needle)}; stdout=${output}; stderr=${stderr}`));
        };
        const timer = setTimeout(() => {
          finish(new Error(`Timed out waiting for ${JSON.stringify(needle)}; stdout=${output}; stderr=${stderr}`));
        }, timeoutMs);
        child.stdout?.on('data', checkOutput);
        child.once('close', checkClose);
        checkOutput();
      });
    },
    async waitForExit(timeoutMs = 30_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Timed out waiting for child exit; stdout=${output}; stderr=${stderr}`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const lifetimeWriter = child.stdio[3] as { destroy?: () => void } | null;
      lifetimeWriter?.destroy?.();
    },
  };
}

test('host lifetime pipe watcher disposes its reader so the process exits while the writer stays open', async () => {
  const fixture = startFixture(`
const watcher = watchHostLifetimePipe(3, {
  onEof() { process.exit(17); },
  onError() { process.exit(18); },
});
watcher.dispose();
process.exit(0);
`);
  try {
    // Keep both the child stdin and fd 3 parent writers open until after its
    // exit. On Windows, an fd 3 ReadStream previously pinned shutdown here.
    const exit = await fixture.waitForExit();
    assert.deepEqual(exit, { code: 0, signal: null }, fixture.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('host lifetime pipe EOF fires once when fd 3 closes while stdin remains open', async () => {
  const fixture = startFixture(`
let eofCount = 0;
const watcher = watchHostLifetimePipe(3, {
  onEof() {
    eofCount += 1;
    process.stdout.write('EOF:' + eofCount + '\\n');
  },
  onError(error) {
    console.error(error);
    process.exit(2);
  },
});
process.stdin.on('end', () => {
  watcher.dispose();
  process.stdout.write('COUNT:' + eofCount + '\\n', () => process.exit(eofCount === 1 ? 0 : 1));
});
process.stdin.resume();
process.stdout.write('READY\\n');
`);
  try {
    const lifetimeWriter = fixture.child.stdio[3] as { end(): void } | null;
    assert.ok(lifetimeWriter, 'fd 3 parent writer exists');
    const stdinWriter = fixture.child.stdin;
    assert.ok(stdinWriter, 'child stdin parent writer exists');

    await fixture.waitForOutput('READY\n');
    assert.equal(fixture.child.exitCode, null, 'the child is still running while both pipes are open');

    lifetimeWriter.end();
    await fixture.waitForOutput('EOF:1\n');
    assert.equal(stdinWriter.writableEnded, false, 'stdin remains open when lifetime-pipe EOF is observed');

    stdinWriter.end();
    const exit = await fixture.waitForExit();
    assert.deepEqual(exit, { code: 0, signal: null }, fixture.stderr);
    assert.equal(fixture.output.match(/EOF:/g)?.length, 1, fixture.output);
    assert.match(fixture.output, /COUNT:1\n/);
  } finally {
    fixture.cleanup();
  }
});
