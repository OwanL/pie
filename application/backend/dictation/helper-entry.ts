import { runHelper } from './helper.mjs';
void runHelper().catch(() => { process.exitCode = 1; });
