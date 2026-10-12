import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DictationService } from '../../dictation/service.js';
import type { DictationObservation } from '../../../lib/protocol/dictation.js';

test('replacement start waits for helper done after a public terminal observation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie-dictation-retry-'));
  const sdkPath = join(directory, 'packages/coding-agent');
  await mkdir(sdkPath, { recursive: true });
  const helperScript = join(directory, 'helper.cjs');
  await writeFile(helperScript, `
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
send({ready:true});
let starts=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.kind==='shutdown')process.exit(0);
 if(c.kind==='start'){
  starts++;
  if(starts===1){
   const frame=JSON.stringify({token:c.token,observation:{kind:'transcript',text:'old',final:true}})+'\\n';
   process.stdout.write(frame.slice(0,12));
   setTimeout(()=>process.stdout.write(frame.slice(12)),5);
   setTimeout(()=>send({token:c.token,done:true}),80);
  } else send({token:c.token,observation:{kind:'status',phase:'recording'}});
 }
});`);
  const previous = process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK;
  process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK = '1';
  const service = new DictationService({
    helperScript,
    cacheDirectory: directory,
    resolveLaunch: async () => ({ nodePath: process.execPath, sdkPath, sdkRuntimeSelection: { kind: 'workspace-development', workspaceRoot: directory } }),
  });
  t.after(async () => {
    try { await service.shutdown(); } catch { /* preserve the original assertion */ }
    if (previous === undefined) delete process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK;
    else process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const first: DictationObservation[] = [];
  let terminal!: () => void;
  const sawTerminal = new Promise<void>(resolve => { terminal = resolve; });
  await service.start('first', value => {
    first.push(value);
    if (value.kind === 'transcript' && value.final) terminal();
  });
  await sawTerminal;

  const second: DictationObservation[] = [];
  let replacementStarted = false;
  let secondStatus!: () => void;
  const sawSecondStatus = new Promise<void>(resolve => { secondStatus = resolve; });
  const replacement = service.start('second', value => {
    second.push(value);
    if (value.kind === 'status') secondStatus();
  }).then(() => { replacementStarted = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(replacementStarted, false, 'replacement must remain queued until the prior done frame');
  await replacement;
  await sawSecondStatus;

  assert.equal(first.filter(value => value.kind === 'transcript' && value.final).length, 1);
  assert.deepEqual(second, [{ kind: 'status', phase: 'recording' }], 'the old terminal frame must not reach the replacement callback');
});
