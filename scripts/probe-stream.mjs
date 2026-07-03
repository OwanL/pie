#!/usr/bin/env node
/**
 * Stream-truncation probe — isolates whether the LiteLLM proxy is the source
 * of the "OpenAI Responses stream ended before a terminal response event"
 * mid-generation kills reported on umans.
 *
 * Sends an IDENTICAL streaming /chat/completions request to BOTH:
 *   - the proxy  (http://127.0.0.1:4000/v1) — how pi calls umans today
 *   - umans direct (https://api.code.umans.ai/v1) — bypassing the proxy
 *
 * Instruments the SSE lifecycle of each:
 *   - time to first byte / first chunk
 *   - chunk count + total bytes
 *   - max gap between chunks (idle — the prime truncation trigger)
 *   - whether the stream ended cleanly (`data: [DONE]`) or abruptly
 *   - final finish_reason + any error
 *
 * Runs N rounds, alternating order (proxy/direct) to avoid systematic bias,
 * and prints a side-by-side summary. Exits non-zero if proxy truncates while
 * direct succeeds (the signature that implicates the proxy).
 *
 * Usage:
 *   node scripts/probe-stream.mjs [--rounds 5] [--think] [--model umans-coder]
 *                                 [--fanout 4]   # concurrent requests to surface load truncation
 *
 * Requires UMANS_API_KEY in env (same key pi uses). Does NOT touch the proxy
 * config or restart anything — read-only against the running proxy + upstream.
 */
import { performance } from 'node:perf_hooks';

const PROXY_BASE = process.env.PIE_PROXY_BASE ?? 'http://127.0.0.1:4000/v1';
const DIRECT_BASE = 'https://api.code.umans.ai/v1';
const API_KEY = process.env.UMANS_API_KEY;

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const ROUNDS = Number(flag('rounds', '5'));
const MODEL = flag('model', 'umans-coder');
const USE_THINK = args.includes('--think');
const FANOUT = Number(flag('fanout', '0')); // 0 = sequential

// A prompt that reliably produces a multi-second reasoning stream (long enough
// to expose idle gaps) but is bounded — not a chat, so no tool calls.
const PROMPT = USE_THINK
  ? 'Reason step by step about the computational complexity of merge sort versus quicksort, then give a one-paragraph summary. Be thorough.'
  : 'Count from 1 to 30, one number per line, no commentary.';

const REQ_BODY = {
  model: MODEL,
  messages: [{ role: 'user', content: PROMPT }],
  stream: true,
  ...(USE_THINK ? { reasoning_effort: 'medium' } : {}),
};

function authHeaders(base) {
  // Proxy: LiteLLM master_key == UMANS_API_KEY (see litellm_config.yaml).
  // Direct: the real umans key.
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
}

async function probe(label, base) {
  const t0 = performance.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(base),
    body: JSON.stringify(REQ_BODY),
  });
  const tHeaders = performance.now();
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '<unreadable>');
    return {
      label, base,
      status: res.status,
      error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
      ttfbMs: Math.round(tHeaders - t0),
      chunks: 0, bytes: 0, maxGapMs: 0,
      terminal: false,
      finishReason: null,
      durationMs: Math.round(performance.now() - t0),
    };
  }
  let chunks = 0, bytes = 0, firstChunkMs = 0, lastChunkMs = 0, maxGapMs = 0;
  let sawDone = false, finishReason = null, errMid = null;
  let contentDeltas = 0;
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (!sawDone) errMid = 'stream ended without [DONE]';
        break;
      }
      const now = performance.now();
      chunks++;
      const chunkStr = decoder.decode(value, { stream: true });
      bytes += chunkStr.length;
      if (firstChunkMs === 0) firstChunkMs = now - t0;
      if (lastChunkMs !== 0) maxGapMs = Math.max(maxGapMs, now - lastChunkMs);
      lastChunkMs = now;
      buf += chunkStr;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data: ')) line = line.slice(6);
        if (line === '[DONE]') { sawDone = true; break; }
        if (!line) continue;
        // data: {...}
        try {
          const obj = JSON.parse(line);
          const choice = obj.choices?.[0];
          if (choice?.delta?.content) contentDeltas++;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (obj.error) errMid = `stream error obj: ${JSON.stringify(obj.error).slice(0, 200)}`;
        } catch {
          // partial/non-JSON chunk; ignore
        }
      }
    }
  } catch (e) {
    errMid = `read threw: ${e?.message ?? String(e)}`;
  }
  return {
    label, base, status: res.status,
    error: errMid,
    ttfbMs: Math.round(firstChunkMs || (tHeaders - t0)),
    chunks, bytes, contentDeltas,
    maxGapMs: Math.round(maxGapMs),
    terminal: sawDone,
    finishReason,
    durationMs: Math.round(performance.now() - t0),
  };
}

function row(r) {
  if (!r) return '  (no result)';
  const flag = r.terminal ? 'OK ' : 'TRUNC';
  return `${flag} ${r.label.padEnd(7)} status=${r.status} ttfb=${String(r.ttfbMs).padStart(5)}ms chunks=${String(r.chunks).padStart(4)} bytes=${String(r.bytes).padStart(6)} maxGap=${String(r.maxGapMs).padStart(6)}ms finish=${r.finishReason} dur=${String(r.durationMs).padStart(6)}ms ${r.error ? 'ERR=' + r.error : ''}`;
}

async function main() {
  if (!API_KEY) {
    console.error('UMANS_API_KEY not set in env');
    process.exit(2);
  }
  console.log(`probe-stream — ${ROUNDS} rounds, model=${MODEL}, think=${USE_THINK}, fanout=${FANOUT || 'seq'}`);
  console.log(`  proxy : ${PROXY_BASE}`);
  console.log(`  direct: ${DIRECT_BASE}`);
  console.log('');
  const results = { proxy: [], direct: [] };

  async function oneRound(i) {
    // In fanout mode, fire N proxy + N direct concurrently (mirrors subagent
    // fan-out hitting the umans 4-concurrent limit). In sequential mode, one of
    // each, alternate order.
    const tasks = [];
    for (let f = 0; f < Math.max(1, FANOUT); f++) {
      tasks.push(probe('proxy', PROXY_BASE));
      tasks.push(probe('direct', DIRECT_BASE));
    }
    const rs = await Promise.all(tasks);
    // interleave log to keep readable
    for (const r of rs) {
      results[r.label].push(r);
      console.log(`  r${i+1} ${row(r)}`);
    }
  }

  if (FANOUT > 0) {
    for (let i = 0; i < ROUNDS; i++) {
      console.log(`--- round ${i + 1}/${ROUNDS} (fanout ${FANOUT}) ---`);
      await oneRound(i);
    }
  } else {
    for (let i = 0; i < ROUNDS; i++) {
      console.log(`--- round ${i + 1}/${ROUNDS} ---`);
      const order = i % 2 === 0 ? ['proxy', 'direct'] : ['direct', 'proxy'];
      for (const which of order) {
        const base = which === 'proxy' ? PROXY_BASE : DIRECT_BASE;
        const r = await probe(which, base);
        results[which].push(r);
        console.log('  ' + row(r));
      }
    }
  }
  console.log('\n=== SUMMARY ===');
  function summarize(arr, name) {
    const ok = arr.filter(r => r.terminal);
    const trunc = arr.filter(r => !r.terminal);
    const avgMaxGap = arr.length ? Math.round(arr.reduce((a, r) => a + r.maxGapMs, 0) / arr.length) : 0;
    const avgDur = arr.length ? Math.round(arr.reduce((a, r) => a + r.durationMs, 0) / arr.length) : 0;
    const avgChunks = arr.length ? Math.round(arr.reduce((a, r) => a + r.chunks, 0) / arr.length) : 0;
    console.log(`${name.padEnd(7)} ok=${ok.length}/${arr.length} trunc=${trunc.length} avgChunks=${avgChunks} avgMaxGap=${avgMaxGap}ms avgDur=${avgDur}ms`);
    if (trunc.length) {
      console.log('  truncation samples:');
      for (const r of trunc) console.log('    ' + row(r));
    }
    return { ok: ok.length, trunc: trunc.length, avgMaxGap, avgDur, avgChunks };
  }
  const s = { proxy: summarize(results.proxy, 'proxy'), direct: summarize(results.direct, 'direct') };
  console.log('');
  let verdict = 'INCONCLUSIVE';
  let exit = 0;
  if (s.proxy.trunc > 0 && s.direct.trunc === 0) {
    verdict = `PROXY IMPLICATED: proxy truncated ${s.proxy.trunc}/${results.proxy.length} while direct truncated 0/${results.direct.length}`;
    exit = 3;
  } else if (s.proxy.trunc === 0 && s.direct.trunc === 0) {
    verdict = 'BOTH CLEAN — no truncation observed at this load/prompt; truncation may require longer reasoning or concurrency.';
  } else if (s.proxy.trunc > 0 && s.direct.trunc > 0) {
    verdict = `UPSTREAM IMPLICATED: both proxy (${s.proxy.trunc}) and direct (${s.direct.trunc}) truncated — fault is umans, not the proxy.`;
  } else if (s.direct.trunc > 0 && s.proxy.trunc === 0) {
    verdict = `UNEXPECTED: direct truncated ${s.direct.trunc} but proxy did not — possible proxy buffering masking upstream cuts.`;
  }
  console.log(`VERDICT: ${verdict}`);
  process.exit(exit);
}

main().catch(e => { console.error('probe failed:', e); process.exit(1); });
