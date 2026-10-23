import test from 'node:test';
import assert from 'node:assert/strict';
import safeguard, { guardCommand } from '../../../../extensions/safeguard/index.js';

function fixture(hasUI = true) {
	let confirmations = 0;
	const ctx = { cwd: '/repo', hasUI, ui: {
		confirm: async () => { confirmations++; return false; },
		notify: () => {},
	} };
	let hook: any;
	safeguard({ on: (name: string, handler: any) => { if (name === 'tool_call') hook = handler; } } as any);
	return { ctx, count: () => confirmations, hook };
}

const inspections = [
	'netsh interface ipv4 show config', 'netsh advfirewall show allprofiles',
	'netsh wlan show interfaces', 'netsh interface dump', 'netsh help',
	'iptables -L', 'iptables -t nat -nvL', 'iptables --list-rules',
	'iptables -S INPUT', 'iptables-save', 'iptables-save -t nat', 'iptables --version', 'iptables --help',
	'ufw status verbose', 'ufw show raw', 'ufw help',
	'chmod 777 ./fixture', 'chmod -R 777 ./fixture', 'chmod 777 /repo/fixture',
	'chmod 755 ./777', 'chmod 755 777', 'chmod --reference=./777 ./fixture',
];
for (const command of inspections) test(`no confirmation: ${command}`, async () => {
	const f = fixture();
	assert.equal(await f.hook({ toolName: 'bash', input: { command } }, f.ctx), undefined);
	assert.equal(await guardCommand(command, f.ctx as any), undefined);
	assert.equal(f.count(), 0);
});

const mutations = [
	'netsh interface ipv4 set address name=show static 1.2.3.4',
	'netsh advfirewall set allprofiles state off', 'netsh unknown show',
	'iptables -A INPUT -j DROP', 'iptables -L -F', 'iptables -LA INPUT -j DROP',
	'iptables --list --append INPUT -j DROP', 'iptables -L -A INPUT', 'iptables --unknown',
	'ufw allow 22', 'ufw delete allow show', 'ufw unknown',
	'chmod 777 /', 'chmod -R 777 /etc', 'chmod 777 ../outside',
	'chmod -R 755 /etc', 'sudo iptables -L',
];
for (const command of mutations) test(`confirmation retained: ${command}`, async () => {
	const f = fixture();
	assert.ok(await f.hook({ toolName: 'bash', input: { command } }, f.ctx));
	assert.equal(f.count(), 1);
});
for (const toolName of ['write', 'edit']) for (const key of ['id_ed25519', 'id_rsa']) {
	for (const suffix of ['', '.pub']) test(`${toolName} SSH ${key}${suffix}`, async () => {
		const f = fixture();
		const result = await f.hook({ toolName, input: { path: `/home/user/.ssh/${key}${suffix}` } }, f.ctx);
		assert.equal(f.count(), suffix ? 0 : 1);
		assert.equal(Boolean(result), !suffix);
	});
}
test('hard blocks and noninteractive rules remain intact', async () => {
	const f = fixture(false);
	assert.ok(await guardCommand('mkfs.ext4 /dev/sda', f.ctx as any));
	assert.ok(await guardCommand('ufw disable', f.ctx as any));
	assert.equal(await guardCommand('ufw status', f.ctx as any), undefined);
	assert.equal(f.count(), 0);
	const previous = process.env.PIE_AUTONOMOUS_MODE;
	try {
		process.env.PIE_AUTONOMOUS_MODE = '1';
		const interactive = fixture();
		assert.ok(await guardCommand('ufw disable', interactive.ctx as any));
		assert.equal(interactive.count(), 0);
	} finally {
		if (previous === undefined) delete process.env.PIE_AUTONOMOUS_MODE;
		else process.env.PIE_AUTONOMOUS_MODE = previous;
	}
});
