import assert from 'node:assert/strict';
import { LIFECYCLE_SDK_EVENT_HANDLERS } from '../session-event-lifecycle.js';
import { isAgentSettledPayload } from '../../lib/rpc/event-payload-validation.js';
import test from 'node:test';
import { consumeDelegatedInput, claimDelegatedHandoff, claimExplicitFulfillment, boundHandoffText, delegatedRolePrompt } from '../delegated-session.js';
import { createSessionControlSender, createSessionReplyReference } from '../../lib/rpc/session-control-attribution.js';
import { AGENT_CREATED_SESSION_CUSTOM_TYPE } from '../../../session-storage/metadata/session-provenance.js';

function fixture() {
  const entries: any[] = [{ type: 'custom', customType: AGENT_CREATED_SESSION_CUSTOM_TYPE, data: { version: 1, sessionId: 'child', creator: { sessionId: 'parent', identityFallback: false } } }];
  const manager = { getSessionId: () => 'child', getEntries: () => entries, appendCustomEntry(customType: string, data: unknown) { entries.push({type:'custom',customType,data}); return 'claim'; } };
  const context: any = { sessionPath:'child.jsonl', session: {sessionManager:manager}, activeRequest: {id:'run', aborted:false, messageIndex:1, lastAssistantMessageId:'assistant'} };
  Object.assign(manager,{getBranch: () => entries});
  const sender = createSessionControlSender({sessionId:'parent',identityFallback:false},undefined,{sentAt:1,expectReply:true});
  return {context, manager, sender, entries};
}
test('only delivered creator reply requests accumulate; settlement claims once', () => {
  const {context,sender,entries} = fixture();
  consumeDelegatedInput(context,'a',sender);
  consumeDelegatedInput(context,'a',sender);
  consumeDelegatedInput(context,'b',{...sender,message:{sentAt:1,expectReply:false}});
  consumeDelegatedInput(context,'c',{...sender,message:{sentAt:1,expectReply:true,kind:'completion'}});
  consumeDelegatedInput(context,'d',{...sender,identity:{sessionId:'peer',identityFallback:false}});
  consumeDelegatedInput(context,'e',sender);
  const handoff = claimDelegatedHandoff(context, context.activeRequest, 'done');
  assert.deepEqual(handoff?.inputIds,['a','e']);
  assert.equal(handoff?.text,'done');
  assert.equal(entries.at(-1).data.childSessionId,'child');
  assert.equal(claimDelegatedHandoff(context,context.activeRequest,'again'),undefined);
  context.activeRequest = {...context.activeRequest,id:'new-run'};
  consumeDelegatedInput(context,'a',sender);
  consumeDelegatedInput(context,'e',sender);
  assert.equal(claimDelegatedHandoff(context,context.activeRequest,'replay'),undefined);
  assert.equal(claimDelegatedHandoff({...context,delegation:undefined},context.activeRequest,'restart'),undefined);
});
test('fork role absent, ordinary human runs inert; error and cancelled outcomes bounded', () => {
  for (const outcome of ['error','cancelled'] as const) {
    const {context,sender} = fixture();
    assert.equal(claimDelegatedHandoff(context,context.activeRequest,'human'),undefined);
    consumeDelegatedInput(context,'a',sender);
    assert.equal(claimDelegatedHandoff(context,context.activeRequest,'x'.repeat(40000),outcome)?.outcome,outcome);
  }
  const {manager} = fixture();
  assert.match(delegatedRolePrompt(manager),/session_finish/);
  assert.match(delegatedRolePrompt(manager),/awaiting-result/);
  assert.match(delegatedRolePrompt(manager),/human/i);
  manager.getSessionId = () => 'fork';
  assert.equal(delegatedRolePrompt(manager),'');
});

test('explicit fulfillment claims before send and leaves only remaining obligations', () => {
  const {context,sender} = fixture();
  consumeDelegatedInput(context,'a',sender);
  consumeDelegatedInput(context,'b',sender);
  const payload = {fulfills:['a'], expectReply:false, replyTo:createSessionReplyReference(sender.identity)};
  assert.throws(() => claimExplicitFulfillment(context,{...payload,expectReply:true}));
  claimExplicitFulfillment(context,payload);
  consumeDelegatedInput(context,'a',sender);
  assert.throws(() => claimExplicitFulfillment(context,payload));
  assert.deepEqual(claimDelegatedHandoff(context,context.activeRequest,'remaining')?.inputIds,['b']);
});
test('unknown/fenced claim is never attempted again; multibyte output respects byte budget', () => {
  const {context,sender,manager} = fixture();
  consumeDelegatedInput(context,'a',sender);
  manager.appendCustomEntry = () => { throw new Error('unknown write'); };
  assert.throws(() => claimDelegatedHandoff(context,context.activeRequest,'done'));
  assert.equal(claimDelegatedHandoff(context,context.activeRequest,'again'),undefined);
  const bounded = boundHandoffText('😀'.repeat(40000));
  assert.ok(Buffer.byteLength(bounded,'utf8') <= 48 * 1024);
  assert.ok(!bounded.includes('�'));
});

test('only correlated full settlement publishes a valid handoff, never agent_end/retry or duplicate settlement', () => {
  const {context,sender,entries} = fixture();
  consumeDelegatedInput(context,'a',sender);
  entries.push({type:'message',message:{role:'assistant',content:[{type:'text',text:'Verified final'}]}});
  const emitted: Array<{name:string;payload:any}> = [];
  const deps: any = {emit:(name:string,payload:any)=>emitted.push({name,payload}),emitContextUsageChanged:()=>{},emitBusyChanged:()=>{},emitSessionOpened:async()=>{},emitSessionListChanged:async()=>{}};
  LIFECYCLE_SDK_EVENT_HANDLERS.agent_end(deps,context,{type:'agent_end',willRetry:true});
  LIFECYCLE_SDK_EVENT_HANDLERS.agent_end(deps,context,{type:'agent_end',willRetry:false});
  assert.equal(emitted.length,0);
  LIFECYCLE_SDK_EVENT_HANDLERS.agent_settled(deps,context,{type:'agent_settled'});
  const settled = emitted.find(e => e.name === 'agent.settled')!.payload;
  assert.equal(settled.handoff.text,'Verified final');
  assert.ok(isAgentSettledPayload(settled));
  assert.equal(isAgentSettledPayload({...settled,handoff:{...settled.handoff,text:'x'.repeat(50000)}}),false);
  LIFECYCLE_SDK_EVENT_HANDLERS.agent_settled(deps,context,{type:'agent_settled'});
  assert.equal(emitted.filter(e => e.payload?.handoff).length,1);
});
