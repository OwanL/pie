// Reproduction harness: count SIGINT listeners added by creating subagent sessions.
// Run from pie/extension: node ../local_utils/repro-sigint-leak.mjs
import process from "node:process";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

// Resolve the real SDK path: pie aliases @mariozechner/pi-coding-agent to the
// globally-installed @earendil-works/pi-coding-agent. Resolve its dist entry.
const candidates = [
	"C:/Users/OwanLazic/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent",
	"C:/Users/OwanLazic/Documents/GitHub/pie/extension/node_modules/@earendil-works/pi-coding-agent",
];
let sdkRoot = candidates.find((p) => fs.existsSync(path.join(p, "package.json")));
if (!sdkRoot) {
	console.error("[repro] could not locate SDK in:", candidates);
	process.exit(1);
}
console.log("[repro] using SDK at:", sdkRoot);
const pkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
const entry = pkg.main || pkg.exports?.["."]?.import || "dist/main.js";
const sdkUrl = pathToFileURL(path.join(sdkRoot, entry)).href;

const dumpListeners = (label) => {
	const n = process.listenerCount("SIGINT");
	console.log(`[repro] ${label}: SIGINT listeners = ${n}`);
	for (const [i, fn] of process.listeners("SIGINT").entries()) {
		const src = fn.toString().slice(0, 100).replace(/\s+/g, " ");
		console.log(`[repro]   [${i}] ${src}`);
	}
};

dumpListeners("before import");
const sdk = await import(sdkUrl);
dumpListeners("after import");

const { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } = sdk;
const cwd = process.cwd();

for (let i = 0; i < 4; i++) {
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		appendSystemPrompt: undefined,
		noExtensions: false,
	});
	await resourceLoader.reload?.();
	dumpListeners(`after resourceLoader.reload #${i} (noExtensions:false)`);
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		modelRegistry: undefined,
		model: undefined,
		thinkingLevel: undefined,
		tools: [],
		sessionManager,
		resourceLoader,
	});
	dumpListeners(`after createSession #${i}`);
	try { session.dispose?.(); } catch {}
}

console.log("[repro] final signal listener counts:", {
	SIGINT: process.listenerCount("SIGINT"),
	SIGTERM: process.listenerCount("SIGTERM"),
	SIGHUP: process.listenerCount("SIGHUP"),
	exit: process.listenerCount("exit"),
});

// --- Verify the cleanup strategy: snapshot before, remove orphaned pool-dispose closures after ---
const before2 = process.listeners("SIGINT");
const rl2 = new DefaultResourceLoader({
	cwd,
	agentDir: getAgentDir(),
	appendSystemPrompt: undefined,
	noExtensions: false,
});
await rl2.reload?.();
const after2 = process.listeners("SIGINT");
const added = after2.filter((fn) => !before2.includes(fn));
console.log("[repro] cleanup-probe added listeners by signature:");
for (const fn of added) {
	const body = fn.toString();
	const looksLikePoolDispose = /pools\.values\(\)/.test(body) && /\.dispose\(\)/.test(body);
	console.log(`[repro]   pool-dispose-shape=${looksLikePoolDispose}  body=${body.slice(0, 90).replace(/\s+/g, " ")}`);
	// Remove the orphan (the SDK never gives us a handle to do this ourselves).
	if (looksLikePoolDispose) process.removeListener("SIGINT", fn);
}
console.log("[repro] SIGINT after cleanup:", process.listenerCount("SIGINT"));
process.exit(0);
