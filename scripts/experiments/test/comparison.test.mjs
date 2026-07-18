import test from "node:test";
import assert from "node:assert/strict";
import { hasStartupAttestationDrift, pairedPassTest, pairedScoreTest, pairedVerdict } from "../lib/comparison.mjs";

const pair=(baselineScore,candidateScore,baselinePassed=true,candidatePassed=true)=>({baseline:{primaryScore:baselineScore,trialPassed:baselinePassed},candidate:{primaryScore:candidateScore,trialPassed:candidatePassed}});

test("paired pass test uses only discordant outcomes",()=>{
 const result=pairedPassTest([pair(0,0,true,false),pair(0,0,true,false),pair(0,0,false,true),pair(0,0,true,true)]);
 assert.deepEqual(result,{candidateWins:1,candidateLosses:2,discordant:3,twoSidedP:1});
});

test("paired score randomization is deterministic and does not flag noisy no-op deltas",()=>{
 const deltas=[-0.9,-0.87,0.24,0.14,-0.14,0.145,-0.108,...Array(17).fill(0)];
 const first=pairedScoreTest(deltas,{iterations:20_000,seed:417291}),second=pairedScoreTest(deltas,{iterations:20_000,seed:417291});
 assert.deepEqual(first,second);
 assert.ok(first.absoluteMeanDelta>0.03);
 assert.ok(first.twoSidedP>0.05);
});

test("paired verdict requires statistical and practical significance",()=>{
 const noisy=[pair(0.9,0),pair(0.9,0),pair(0,0.24),...Array.from({length:21},()=>pair(0.7,0.7))];
 assert.equal(pairedVerdict({pairs:noisy,totalPairs:24,iterations:20_000}).verdict,"neutral");
 const regression=Array.from({length:24},()=>pair(0.8,0.6));
 assert.equal(pairedVerdict({pairs:regression,totalPairs:24,iterations:20_000}).verdict,"regressed");
 const improvement=Array.from({length:24},()=>pair(0.6,0.8));
 assert.equal(pairedVerdict({pairs:improvement,totalPairs:24,iterations:20_000}).verdict,"promising");
});

test("startup attestation permits declared treatment differences but detects within-cell drift",()=>{
 const result=(treatment,extensions,model="umans/a")=>({task:"task",treatment,startupSnapshot:{model,tools:["read"],extensions}});
 assert.equal(hasStartupAttestationDrift([result("baseline",["policy"]),result("baseline",["policy"],"umans/b"),result("candidate",["policy","treatment"]),result("candidate",["policy","treatment"],"umans/b")]),false);
 assert.equal(hasStartupAttestationDrift([result("baseline",["policy"]),result("baseline",["policy","unexpected"])]),true);
});

test("paired verdict fails closed for integrity and missing pairs",()=>{
 const pairs=[pair(0.5,0.5)];
 assert.equal(pairedVerdict({pairs,totalPairs:1,infrastructureInvalid:true,iterations:100}).verdict,"invalid");
 assert.equal(pairedVerdict({pairs,totalPairs:2,iterations:100}).verdict,"inconclusive");
});
