import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { RuntimeClient } from '../../src/runtime-client.js';

const root = process.argv[2];
if (!root) throw new Error('runtime-owner requires a temporary root path');
await mkdir(root, { recursive: true });
const sessionPath = path.join(root, 'owner-session.jsonl');
const artifactDir = path.join(root, 'artifacts');
await mkdir(artifactDir, { recursive: true });

const client = new RuntimeClient(sessionPath);
await client.request('open', { sessionId: 'owner', artifactDir, url: 'about:blank' }, { sessionId: 'owner', timeoutMs: 30_000, allowNeedsReopen: true });
client.markReopened();
const pids = await client.request('debug_pids', {}, { timeoutMs: 10_000 }) as unknown as { sidecarPid: number; browserPids: number[] };
process.stdout.write(`READY ${JSON.stringify({ ownerPid: process.pid, ...pids })}\n`);
setInterval(() => {}, 1000);
