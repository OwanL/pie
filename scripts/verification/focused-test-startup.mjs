// Keep the focused runner alive and child-free until its parent has completed
// the Windows live ownership bracket. Require explicit authorization, not EOF.
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { waitForOwnershipAuthorization } from './ownership-startup.mjs';

await waitForOwnershipAuthorization(process.stdin);
// Restore the CLI's ordinary argv without propagating a preload to descendants.
process.argv.splice(1, 1);
await import(pathToFileURL(process.argv[1]).href);
