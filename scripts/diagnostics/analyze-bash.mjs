import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(`find sessions data -name "*.jsonl" -type f`, { encoding: "utf8" })
  .trim().split("\n").filter(Boolean);

const bashCmds = [];
for (const f of files) {
  let txt;
  try { txt = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "message" || !rec.message?.content) continue;
    for (const part of rec.message.content) {
      if (part && part.type === "toolCall" && part.name === "bash" && part.arguments) {
        const cmd = part.arguments.command;
        if (typeof cmd === "string") bashCmds.push(cmd);
      }
    }
  }
}

// classifier: simple = one program + args, no shell metacharacters outside quotes
function isSimple(cmd) {
  const c = cmd.trim();
  if (!c || /\n/.test(c)) return false;
  // remove quoted spans, leave "" / '' placeholders
  const stripped = c
    .replace(/"(?:\\.|[^"])*"/g, '""')
    .replace(/'(?:\\.|[^'])*'/g, "''");
  // shell operators
  if (/[|;&]|\|\||&&|>>|>|<|`|\$\(|\$\{/.test(stripped)) return false;
  // bare glob / tilde / var outside quotes (placeholders are "" or '' so no *?$~ inside)
  if (/[*?~]/.test(stripped)) return false;
  if (/\$/.test(stripped)) return false;
  if (/^\s*\w+=/.test(c)) return false;          // env-assignment prefix
  if (/\{[^{}]*,[^{}]*\}/.test(stripped)) return false; // brace expansion
  return true;
}

const total = bashCmds.length;
const simpleCmds = [], shellCmds = [];
for (const c of bashCmds) (isSimple(c) ? simpleCmds : shellCmds).push(c);
const simple = simpleCmds.length, shell = shellCmds.length;

const pct = (a, t) => (t ? (a / t * 100).toFixed(1) + "%" : "0%");
const trunc = (s, n) => { s = s.replace(/\n/g, " "); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

console.log(`Session files scanned: ${files.length}`);
console.log(`Total bash tool calls: ${total}`);
console.log(`  Simple (fast-pathable, no shell needed): ${simple} (${pct(simple, total)})`);
console.log(`  Shell-needing (pipes/redirects/globs/vars/&&): ${shell} (${pct(shell, total)})`);

console.log("\n--- top 20 simple command prefixes (fast-path wins) ---");
const sp = {};
for (const c of simpleCmds) { const p = c.trim().split(/\s+/).slice(0, 2).join(" "); sp[p] = (sp[p] || 0) + 1; }
Object.entries(sp).sort((a, b) => b[1] - a[1]).slice(0, 20)
  .forEach(([p, n]) => console.log(`  ${String(n).padStart(4)}  ${trunc(p, 70)}`));

console.log("\n--- top 20 shell-needing command prefixes (warm-bash wins) ---");
const hp = {};
for (const c of shellCmds) { const p = c.trim().split(/\s+/).slice(0, 3).join(" "); hp[p] = (hp[p] || 0) + 1; }
Object.entries(hp).sort((a, b) => b[1] - a[1]).slice(0, 20)
  .forEach(([p, n]) => console.log(`  ${String(n).padStart(4)}  ${trunc(p, 70)}`));

// rough "quick shell-needing" heuristic: no build/test/install/run keyword
const slow = /\b(build|test|install|watch|tsc|vitest|jest|eslint|lint|sync|package|deploy|run)\b/i;
const quickShell = shellCmds.filter(c => !slow.test(c)).length;
const slowShell = shell - quickShell;
console.log(`\nOf shell-needing: ~${quickShell} (${pct(quickShell, shell)}) look QUICK (no build/test/install/run keyword), ~${slowShell} (${pct(slowShell, shell)}) look SLOW`);
console.log("(warm-bash only meaningfully helps the QUICK shell-needing share)");
// Refinement: how many "shell-needing" are really just `cd <dir> && <simple cmd>`?
const cdAnd = /^cd\s+("?(?:[^"&|]*?)"?)\s*&&\s*(.+)$/s;
let cdThenSimple = 0, cdThenShell = 0, other = 0;
const afterCd = [];
for (const c of shellCmds) {
  const m = c.trim().match(cdAnd);
  if (m) {
    afterCd.push(m[2]);
    if (isSimple(m[2])) cdThenSimple++; else cdThenShell++;
  } else other++;
}
console.log("\n=== Decomposition of shell-needing commands ===");
console.log(`  cd <dir> && <SIMPLE cmd>  (fast-pathable if bash had a cwd param): ${cdThenSimple} (${pct(cdThenSimple, shell)})`);
console.log(`  cd <dir> && <shell cmd>  (genuinely needs shell):                   ${cdThenShell} (${pct(cdThenShell, shell)})`);
console.log(`  other (pipes/heredocs/redirects/multi-&&):                          ${other} (${pct(other, shell)})`);
console.log(`\n=> If bash tool had a per-call cwd param + cd-aware fast-path:`);
console.log(`   fast-path coverage would jump from ${pct(simple, total)} to ${pct(simple + cdThenSimple, total)}`);
console.log(`\n--- top 15 commands AFTER 'cd ... &&' (what the model really runs) ---`);
const ap = {};
for (const c of afterCd) { const p = c.trim().split(/\s+/).slice(0, 2).join(" "); ap[p] = (ap[p] || 0) + 1; }
Object.entries(ap).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([p, n]) => console.log(`  ${String(n).padStart(4)}  ${trunc(p, 70)}`));
