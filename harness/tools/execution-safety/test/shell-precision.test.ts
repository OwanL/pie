import assert from 'node:assert/strict';
import test from 'node:test';
import safeguard, { guardCommand } from '../../../../extensions/safeguard/index.js';
import { parseShellInvocations } from '../shell.js';

async function check(command: string, action: 'allow' | 'prompt' | 'block', cwd = '/repo') {
	let confirmations = 0;
	const result = await guardCommand(command, { cwd, hasUI: true, ui: {
		confirm: async () => { confirmations++; return true; }, notify: () => {},
	} } as any);
	assert.equal(confirmations, action === 'prompt' ? 1 : 0, command);
	assert.equal(result?.block, action === 'block' ? true : undefined, command);
}

test('shell continuations do not become deletion targets or break executable names', async () => {
	assert.deepEqual(parseShellInvocations('rm -rf /tmp/task \\\n  2>/dev/null')[0]?.args, ['-rf', '/tmp/task']);
	await check('rm -rf /tmp/task \\\n  2>/dev/null', 'allow');
	await check('r\\\nm -rf /', 'block');
	await check('echo "literal\\\ntext"', 'allow');
	assert.equal(parseShellInvocations("echo 'literal\\\ntext'")[0]?.args[0], 'literal\\\ntext');
});

test('cleanup uses execution directory while retaining original project boundary', async () => {
	for (const command of [
		'cd /repo/sub && rm -rf ../build',
		'cd ./sub && rm -rf ../build',
		'cd /outside && rm -rf /repo/build',
		'cd /repo/sub && echo ready && rm -rf ../build',
		'cd /outside || rm -rf ./build',
	]) await check(command, 'allow');
	for (const command of [
		'cd /outside && rm -rf ./build',
		'cd /outside; rm -rf ./build',
		'cd /outside && echo ready; rm -rf ./build',
		'cd /repo/sub; rm -rf ../build', // cd may fail, leaving /repo
		'cd "$DEST" && rm -rf ./build',
		'cd /outside && chmod 777 ./fixture',
	]) await check(command, 'prompt');
});

test('directory tracking respects short-circuiting, pipes and background commands', async () => {
	await check('cd /outside && false || rm -rf ./build', 'prompt');
	await check('cd /repo/sub && ! cd /outside || rm -rf ./build', 'prompt');
	await check('cd /outside && ! cd /repo || rm -rf ./build', 'allow');
	await check('! rm -rf /', 'block');
	await check('cd /outside | cat; rm -rf ./build', 'allow');
	await check('echo hello | cd /outside; rm -rf ./build', 'allow');
	await check('cd /outside & rm -rf ./build', 'allow');
	await check('cd /repo/sub && echo ready & rm -rf ../build', 'prompt');
	await check('cd /outside && echo ready & rm -rf ./build', 'allow');
	await check("cd /repo/sub && sh -c 'rm -rf ../build'", 'allow');
	await check("cd /outside && sh -c 'rm -rf ./build'", 'prompt');
	await check('cd /repo/sub && rm -rf ../..', 'block');
});

test('hard blocks dominate every nested-shell prompt regardless of order', async () => {
	await check("bash -c 'sudo apt update'; sh -c 'rm -rf /'", 'block');
	await check("bash -c 'rm -rf /'; sh -c 'sudo apt update'", 'block');
});

test('Git Bash aliases remain project-local without exempting drive roots or system writes', async () => {
	if (process.platform !== 'win32') return;
	await check('rm -rf /c/repo/build', 'allow', 'C:/repo');
	await check('cd /c/repo/sub && rm -rf ../build', 'allow', 'C:/repo');
	await check('rm -rf /c/', 'block', 'C:/repo');
	await check('rm -rf /c', 'block', 'C:/repo');
	let hook: any;
	safeguard({ on: (_name: string, handler: any) => { hook = handler; } } as any);
	for (const toolName of ['write', 'edit']) {
		const result = await hook({ toolName, input: { path: '/c/Windows/System32/example.dll' } }, {
			cwd: 'C:/repo', hasUI: false,
		});
		assert.equal(result?.block, true);
	}
});
