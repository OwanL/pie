import { inspectDevelopmentWorkspace } from '../../lib/development-runtime/lifetime.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('--')) {
  console.error('Usage: node scripts/development/inspect-workspace.mjs <Pi-workspace-root>');
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify({
      warning: 'Read-only non-atomic snapshot; not lifetime proof or recovery authorization. No PID/age reclamation.',
      ...await inspectDevelopmentWorkspace(args[0]),
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
