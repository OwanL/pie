/**
 * ESM fixture entry for the prepass completion-entry regression. The parent
 * test bundles this source together with prepass and selector state while
 * leaving public Pi exports external to the verified runtime artifact.
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const selectedBinding = process.env.PREPASS_COMPLETION_ENTRY_SOURCE_DESCRIPTOR;
assert.ok(selectedBinding, "driver must bind this worker to the selected source descriptor");
const descriptor = JSON.parse(selectedBinding) as { artifactDir?: string; sdkPath?: string };
assert.equal(descriptor.artifactDir, process.env.PREPASS_COMPLETION_ENTRY_ARTIFACT_DIR,
	"worker descriptor must match the parent's selected artifact");
assert.equal(descriptor.sdkPath, process.env.PREPASS_COMPLETION_ENTRY_SDK_PATH,
	"worker descriptor must match the parent's selected SDK package");

const expectedCompatPath = realpathSync(process.env.PREPASS_COMPLETION_ENTRY_COMPAT_PATH ?? "");
const piAiRoot = realpathSync(process.env.PREPASS_COMPLETION_ENTRY_PI_AI_ROOT ?? "");
const compatRelativePath = path.relative(piAiRoot, expectedCompatPath);
assert.ok(compatRelativePath !== ".." && !compatRelativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(compatRelativePath),
	`the public compat export must belong to the selected artifact's pi-ai package: ${expectedCompatPath}`);

const denialLogPath = process.env.PREPASS_COMPLETION_ENTRY_DENY_LOG_PATH ?? "";
assert.ok(path.isAbsolute(denialLogPath), "driver must provide an isolated network-denial log path");

test("the lazy prepass adapter uses the same verified public compat module and faux provider", async () => {
	// The ESM bundle maps this public import to the absolute verified artifact
	// export, so both importers share its native ESM module instance.
	const prepass = await import("../prepass.ts");
	const { getCompleteFnOverride, state } = await import("../../state/selector-state.ts");
	const compat = await import("@earendil-works/pi-ai/compat");
	const resolvedCompatUrl = import.meta.resolve(pathToFileURL(expectedCompatPath).href);
	assert.equal(realpathSync(fileURLToPath(resolvedCompatUrl)), expectedCompatPath,
		"the external ESM module URL must identify the selected artifact's public compat export");
	assert.equal(typeof compat.completeSimple, "function", "compat must export completeSimple");
	assert.equal(typeof compat.registerFauxProvider, "function", "compat must export the api-registry faux provider");
	assert.equal(typeof compat.fauxAssistantMessage, "function", "compat must export the faux message builders");

	assert.equal(state._piCompleteSimple, undefined, "the compat entry must start lazily unresolved");
	assert.equal(getCompleteFnOverride(), null,
		"no completion override may be set: exercise the adapter's lazy public resolution path");

	const faux = compat.registerFauxProvider({
		api: "skill-pruner-prepass-mock",
		provider: "prepass-mock-provider",
		models: [{ id: "prepass-mock", name: "Prepass Mock Model", reasoning: false, input: ["text" as const], contextWindow: 4096, maxTokens: 256 }],
		tokenSize: { min: 1, max: 1 },
	});
	faux.setResponses([compat.fauxAssistantMessage('{"keep":[]}')]);

	const completeFn = prepass.getCompleteFn(undefined);
	assert.ok(completeFn, "getCompleteFn must return the lazy-resolving adapter without an override");
	const context = [
		{ role: "system", content: "Prepass system prompt" },
		{ role: "user", content: "Prepass user prompt" },
		{ role: "assistant", content: '{"keep":["stale"]}' },
		{ role: "user", content: "Return ONLY valid JSON." },
	];

	const result = await completeFn(faux.models[0], context, {
		maxRetries: 0,
		signal: AbortSignal.timeout(10_000),
	});
	assert.equal(result.text, '{"keep":[]}', "the response must flow through the registered faux api provider");
	assert.equal(result.thinking, "");
	assert.equal(result.stopReason, "stop");
	assert.equal(result.errorMessage, undefined);
	assert.ok((result.usage?.input ?? 0) > 0);
	assert.ok((result.usage?.output ?? 0) > 0);
	assert.equal(faux.state.callCount, 1);
	assert.equal(state._piCompleteSimple, compat.completeSimple,
		"the lazy adapter must cache the same compat module function that owns the faux provider registry");

	faux.appendResponses([compat.fauxAssistantMessage('{"keep":[]}')]);
	const cached = await completeFn(faux.models[0], context, {
		maxRetries: 0,
		signal: AbortSignal.timeout(10_000),
	});
	assert.equal(cached.text, '{"keep":[]}');
	assert.equal(faux.state.callCount, 2, "the cached completion entry must serve the second call");
	assert.ok(!existsSync(denialLogPath), "the network-denial preload must record zero network attempts");

	console.log("PREPASS_COMPLETION_ENTRY_OK");
});
