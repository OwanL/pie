const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;

function binomialProbability(n,k){let coefficient=1;for(let i=1;i<=k;i++)coefficient=coefficient*(n-i+1)/i;return coefficient/(2**n);}
function binomialCdf(n,k){let total=0;for(let i=0;i<=Math.min(k,n);i++)total+=binomialProbability(n,i);return total;}

/** Exact paired two-sided McNemar test over discordant pass/fail outcomes. */
export function pairedPassTest(pairs){
 let candidateWins=0,candidateLosses=0;
 for(const pair of pairs){if(pair.baseline.trialPassed===pair.candidate.trialPassed)continue;if(pair.candidate.trialPassed)candidateWins++;else candidateLosses++;}
 const discordant=candidateWins+candidateLosses;
 const twoSidedP=discordant?Math.min(1,2*binomialCdf(discordant,Math.min(candidateWins,candidateLosses))):1;
 return {candidateWins,candidateLosses,discordant,twoSidedP};
}

function nextRandom(state){state.value^=state.value<<13;state.value^=state.value>>>17;state.value^=state.value<<5;return state.value>>>0;}

/** Deterministic paired sign-randomization test for the mean score delta. */
export function pairedScoreTest(deltas,{iterations=200_000,seed=417291}={}){
 if(!deltas.length)return {meanDelta:0,absoluteMeanDelta:0,twoSidedP:1,iterations:0};
 const meanDelta=mean(deltas),observed=Math.abs(meanDelta),state={value:(seed>>>0)||0x9e3779b9};let extreme=0;
 for(let sample=0;sample<iterations;sample++){let randomized=0;for(const delta of deltas)randomized+=(nextRandom(state)&1)?delta:-delta;if(Math.abs(randomized/deltas.length)>=observed-Number.EPSILON)extreme++;}
 return {meanDelta,absoluteMeanDelta:observed,twoSidedP:(extreme+1)/(iterations+1),iterations};
}

export function hasStartupAttestationDrift(results){
 const profilesByCell=new Map();
 for(const result of results.filter(value=>value.startupSnapshot)){const key=`${result.task}/${result.treatment}`,{model,...profile}=result.startupSnapshot;(profilesByCell.get(key)??profilesByCell.set(key,new Set()).get(key)).add(JSON.stringify(profile));}
 return [...profilesByCell.values()].some(profiles=>profiles.size!==1);
}

export function pairedVerdict({pairs,totalPairs,infrastructureInvalid=false,seed=417291,alpha=0.05,minimumPracticalDelta=0.03,iterations=200_000}){
 const complete=pairs.length===totalPairs&&totalPairs>0;
 const pass=pairedPassTest(pairs),score=pairedScoreTest(pairs.map(pair=>pair.candidate.primaryScore-pair.baseline.primaryScore),{iterations,seed});
 let verdict="neutral";
 if(infrastructureInvalid)verdict="invalid";
 else if(!complete)verdict="inconclusive";
 else {
  const passSignal=pass.twoSidedP<=alpha&&pass.candidateWins!==pass.candidateLosses;
  const scoreSignal=score.twoSidedP<=alpha&&score.absoluteMeanDelta>=minimumPracticalDelta;
  const directions=[passSignal?Math.sign(pass.candidateWins-pass.candidateLosses):0,scoreSignal?Math.sign(score.meanDelta):0].filter(Boolean);
  if(directions.includes(-1)&&directions.includes(1))verdict="inconclusive";
  else if(directions.includes(-1))verdict="regressed";
  else if(directions.includes(1))verdict="promising";
 }
 return {verdict,complete,alpha,minimumPracticalDelta,pass,score};
}
