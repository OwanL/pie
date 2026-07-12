import { buildContextWindowBreakdown } from './src/webview/panel/context-window/breakdown';
// Case B extreme: estimate > total -> usedPct>100 -> scale-back drops remaining from bar.
const breakdown = buildContextWindowBreakdown({
  contextUsage: { tokens: 20000, contextWindow: 40000, percent: 50 },
  effectiveContextWindow: 40000,
  systemPrompts: [{ source: 'user', title: 'P', text: 'a'.repeat(400000), summary: 'a'.repeat(400000), availability: 'available' }],
  transcript: [], isPartial: false,
});
const total = breakdown.summary.totalWindow, used = breakdown.summary.usedTokens ?? 0;
const remaining = breakdown.summary.remainingTokens ?? Math.max(total-used,0);
const segs = breakdown.entries.filter(e=>(e.tokens??0)>0).map(e=>e.tokens??0);
const MIN=(2/240)*100;
const usedPct = segs.map(t=>Math.max(t/total*100,MIN)).reduce((a,b)=>a+b,0);
const remainingPct = remaining>0?Math.max(100-usedPct,0):0;
const scaled = usedPct>100;
console.log('segSum', segs.reduce((a,b)=>a+b,0), 'total', total, 'used', used, 'remaining', remaining);
console.log('usedPct', usedPct.toFixed(1), 'scale-back fired:', scaled, 'remainingPct(bar)=', remainingPct.toFixed(1));
console.log('bar renders remaining div?', remainingPct>0, '| legend lists remaining?', remaining>0);
