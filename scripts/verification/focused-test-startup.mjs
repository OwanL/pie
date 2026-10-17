// Keep the focused runner alive and child-free until its parent has completed
// the Windows live ownership bracket. Require explicit authorization, not EOF.
import process from 'node:process';
import { pathToFileURL } from 'node:url';

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Focused test ownership startup handshake timed out')), 30_000);
  process.stdin.once('error', error => { clearTimeout(timer); reject(error); });
  let release = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { release += chunk; });
  process.stdin.once('end', () => {
    clearTimeout(timer);
    if (release === 'pie-focused-ownership-ready\n') resolve();
    else reject(new Error('Focused test ownership startup was not authorized'));
  });
  process.stdin.resume();
});
// Restore the CLI's ordinary argv without propagating a preload to descendants.
process.argv.splice(1, 1);
await import(pathToFileURL(process.argv[1]).href);
