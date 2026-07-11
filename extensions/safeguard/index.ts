/**
 * Safeguard Extension — high-confidence protection against destructive actions.
 *
 * Shell checks are command-aware: quoted text, comments, grep patterns, and
 * heredoc bodies are data and are never treated as commands. Ambiguous policy
 * checks are prompts; only catastrophic operations are hard-blocked.
 */

import { resolvePathForComparison, isUnderCwd } from "./paths";
import { analyzeRecursiveRm, maskShellData, parseShellInvocations, stripHeredocBodies, type ShellInvocation } from "./shell";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 600;

type Safety = { action: "allow" | "block" | "prompt"; reason?: string };

function applyDefaultBashTimeout(input: { command: string; timeout?: number }): void {
	if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0) {
		input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
	}
}

const HARD_BLOCK_PATHS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /^\/boot\//, reason: "Writing to /boot" },
	{ pattern: /^\/dev\//, reason: "Writing to /dev" },
	{ pattern: /^\/proc\//, reason: "Writing to /proc" },
	{ pattern: /^\/sys\//, reason: "Writing to /sys" },
	{ pattern: /^\/etc\/passwd$/, reason: "Writing to /etc/passwd" },
	{ pattern: /^\/etc\/shadow$/, reason: "Writing to /etc/shadow" },
	{ pattern: /^\/etc\/sudoers$/, reason: "Writing to /etc/sudoers" },
	{ pattern: /^c:\/windows\/(?:system32|syswow64)\//, reason: "Writing to a Windows system directory" },
	{ pattern: /^\/\/\.\/physicaldrive/, reason: "Writing to raw physical drive" },
];

// Prompt only for files likely to contain credentials. Generic .env files,
// shell configs, .gitconfig, and .ssh/config are common development targets and
// no longer trigger merely because they live outside the current cwd.
const PROMPT_PATHS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\/(?:\.aws\/credentials|\.docker\/config\.json|\.npmrc)$/, reason: "Writing to a credential-bearing config file" },
	{ pattern: /\/\.gnupg\//, reason: "Writing to GnuPG credentials" },
	{ pattern: /\/\.ssh\/(?:id_[^/]+|[^/]+\.(?:pem|key))$/, reason: "Writing to a private key file" },
];

function hasArg(invocation: ShellInvocation, pattern: RegExp): boolean {
	return invocation.args.some((arg) => pattern.test(arg));
}

function block(reason: string): Safety {
	return { action: "block", reason };
}

function prompt(reason: string): Safety {
	return { action: "prompt", reason };
}

function analyzeInvocation(inv: ShellInvocation): Safety | undefined {
	const { name, args, text } = inv;
	const argText = args.join(" ");

	if (/^mkfs(?:\.|$)/.test(name)) return block("Filesystem creation (mkfs)");
	if (["fdisk", "parted", "diskpart", "wipefs", "blkdiscard"].includes(name)) return block(`Destructive disk operation (${name})`);
	if (["sgdisk", "gdisk"].includes(name) && /--zap/.test(argText)) return block("Zapping partition table");
	if (name === "nvme" && args[0]?.toLowerCase() === "format") return block("NVMe drive format");
	if (name === "cryptsetup" && /^(?:erase|lukserase)$/i.test(args[0] ?? "")) return block("LUKS encryption erase");
	if (name === "badblocks" && hasArg(inv, /^-[^-]*w/)) return block("Destructive badblocks write test");
	if (name === "hdparm" && hasArg(inv, /^--(?:trim-sector-ranges|security-erase)/)) return block("Destructive hdparm operation");
	if (name === "shred" && hasArg(inv, /^\/dev\//)) return block("Shredding block device");
	if (name === "dd" && hasArg(inv, /^of=(?:\/dev\/|\\\\\.\\|\/boot\/)/i)) return block("dd writing to a device or boot files");
	if ([">", "tee"].includes(name) && hasArg(inv, /^\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z])/i)) return block("Writing to block device");

	if (name === "rm" && hasArg(inv, /^\/boot(?:\/|$)/)) return block("Deleting boot files");
	if (name === "mkdir" && hasArg(inv, /^\/boot(?:\/|$)/)) return block("Modifying /boot structure");
	if (name === "rd" && hasArg(inv, /^\/s$/i) && hasArg(inv, /^\/q$/i) && hasArg(inv, /^[a-z]:\\?$/i)) return block("Recursive delete of drive root");
	if (name === "del" && /\/f\b.*\/s\b.*[a-z]:\\/i.test(argText)) return block("Force-delete across drive");
	if (name === "remove-item" && /-recurse/i.test(argText) && hasArg(inv, /^[a-z]:\\?$/i)) return block("PowerShell recursive delete of drive root");
	if (name === "cipher" && hasArg(inv, /^\/w:[a-z]:\\/i)) return block("Wiping free space on drive");

	if (["format-volume", "clear-disk", "initialize-disk", "remove-partition"].includes(name)) return block(`Destructive PowerShell disk operation (${name})`);
	if (name === "bcdedit" && (/\/delete\b/i.test(argText) || /\/set.*recoveryenabled.*no/i.test(argText))) return block("Boot configuration tampering");
	if (name === "reagentc" && hasArg(inv, /^\/disable$/i)) return block("Disabling Windows Recovery Environment");
	if (name === "vssadmin" && /delete\s+shadows/i.test(argText)) return block("Deleting Volume Shadow Copies");
	if (name === "wmic" && /shadowcopy.*delete/i.test(argText)) return block("Deleting shadow copies via WMI");
	if (name === "set-mppreference" && /-disable(?:realtimemonitoring|ioavprotection)\s+\$?true/i.test(argText)) return block("Disabling Windows Defender protection");
	if (name === "disable-windowsoptionalfeature" && /windows-defender/i.test(argText)) return block("Uninstalling Windows Defender");
	if (name === "reg" && args[0]?.toLowerCase() === "delete" && /^hk(?:lm|cr|cu)/i.test(args[1] ?? "")) return block("Deleting Windows registry keys");
	if (name === "certutil" && hasArg(inv, /^-delstore$/i)) return block("Deleting certificates from store");

	if (name === "eval" && /\$\(/.test(text)) return block("eval with command substitution");
	if (name === "bash" && /-i\b.*\/dev\/(?:tcp|udp)\//.test(argText)) return block("Reverse shell via /dev/tcp");
	if (/^(?:nc|ncat)$/.test(name) && hasArg(inv, /^-[^-]*e/) && hasArg(inv, /(?:^|\/)(?:ba|z|k)?sh$/)) return block("Reverse shell via netcat");
	if (name === ":()" || (name === "fork" && /while/.test(argText))) return block("Fork bomb");

	if (["sudo", "doas", "runas"].includes(name)) return prompt(`Privilege escalation (${name})`);
	if (name === "su") return prompt("Switching user (su)");
	if (name === "chmod" && (hasArg(inv, /^777$/) || (hasArg(inv, /^-R$/) && /\/(?:etc|usr|var|boot)\b/.test(argText)))) return prompt("Broad permission change");
	if (name === "chown" && hasArg(inv, /^-R$/) && /\/(?:etc|usr|var|boot)\b/.test(argText)) return prompt("Recursive ownership change on system path");
	if (name === "systemctl" && /^(?:stop|disable|mask)$/.test(args[0] ?? "")) return prompt("Stopping/disabling a system service");
	if (name === "service" && args[1]?.toLowerCase() === "stop") return prompt("Stopping a service");
	if (name === "net" && args[0]?.toLowerCase() === "stop") return prompt("Stopping a Windows service");
	if (name === "sc" && /^(?:delete|config)$/i.test(args[0] ?? "")) return prompt("Changing a Windows service");
	if (["stop-service", "remove-service"].includes(name)) return prompt("Changing a Windows service");
	if (["remove-localuser", "add-localgroupmember"].includes(name) || (name === "net" && /(?:user.*\/delete|localgroup.*administrators.*\/add)/i.test(argText))) return prompt("Changing Windows users or administrators");
	if (["disable-bitlocker", "set-executionpolicy", "disable-netfirewallrule"].includes(name)) return prompt(`Sensitive system configuration (${name})`);
	if (name === "set-netfirewallprofile" && /-enabled\s+false/i.test(argText)) return prompt("Disabling Windows Firewall");
	if (["iptables", "ufw", "netsh"].includes(name)) return prompt(`Modifying firewall/network configuration (${name})`);
	if (["takeown", "icacls"].includes(name) && /[a-z]:\\windows/i.test(argText)) return prompt("Changing Windows system-file ownership");

	const first = args[0]?.toLowerCase();
	if (["apt", "apt-get"].includes(name) && ["remove", "purge"].includes(first ?? "")) return prompt("Removing system packages (apt)");
	if (name === "dnf" && first === "remove") return prompt("Removing system packages (dnf)");
	if (name === "pacman" && hasArg(inv, /^-R/)) return prompt("Removing system packages (pacman)");
	if (["choco", "brew", "winget"].includes(name) && first === "uninstall") return prompt(`Removing packages (${name})`);
	return undefined;
}

function analyzeBash(command: string, cwd: string, depth = 0): Safety {
	const executableSyntax = maskShellData(command);
	if (/(?:^|[;|&\n]\s*|\s)\d*>{1,2}\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z])/i.test(executableSyntax)) {
		return block("Redirecting output to a block device");
	}
	const rmAnalysis = analyzeRecursiveRm(command, cwd);
	if (rmAnalysis?.action === "block") return rmAnalysis;

	const invocations = parseShellInvocations(command);
	for (const invocation of invocations) {
		const result = analyzeInvocation(invocation);
		if (result?.action === "block") return result;
	}

	// High-confidence pipeline checks use parsed executable names, not words in
	// quoted strings. This keeps remote-script and decoder protections without
	// flagging docs/tests that merely mention them.
	for (let index = 0; index < invocations.length - 1; index += 1) {
		const current = invocations[index];
		const next = invocations[index + 1];
		if (current?.operatorAfter === "|" && ["curl", "wget"].includes(current.name) && ["bash", "sh", "zsh", "python", "python3", "node"].includes(next?.name ?? "")) {
			return block("Piping remote content to an interpreter");
		}
		if (current?.operatorAfter === "|" && current.name === "base64" && ["bash", "sh", "zsh", "cmd"].includes(next?.name ?? "")) return block("Base64-decoded content piped to shell");
	}

	if (depth < 2) {
		for (const invocation of invocations) {
			if (!["bash", "sh", "zsh", "pwsh", "powershell"].includes(invocation.name)) continue;
			const flagIndex = invocation.args.findIndex((arg) => arg === "-c" || /^-(?:command|encodedcommand)$/i.test(arg));
			const payload = flagIndex >= 0 ? invocation.args[flagIndex + 1] : undefined;
			if (payload) {
				const nested = analyzeBash(payload, cwd, depth + 1);
				if (nested.action !== "allow") return nested;
			}
		}
	}

	if (rmAnalysis?.action === "prompt") return rmAnalysis;
	for (const invocation of invocations) {
		const result = analyzeInvocation(invocation);
		if (result?.action === "prompt") return result;
	}

	// Exact syntax checks after heredoc removal. Anchoring prevents examples in
	// echo/printf/grep arguments from being mistaken for executable payloads.
	const executableText = stripHeredocBodies(command).trim();
	if (/^:\(\)\s*\{[^}]*\|\s*:.*\}\s*;?\s*:$/.test(executableText)) return block("Fork bomb");
	if (/^bash\s+-i\b[^\n]*\/dev\/(?:tcp|udp)\//.test(executableText)) return block("Reverse shell via /dev/tcp");
	return { action: "allow" };
}

export function isSafe(command: string, options: { cwd?: string } = {}): boolean {
	return analyzeBash(command, options.cwd ?? process.cwd()).action === "allow";
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const input = event.input as { command: string; timeout?: number };
			applyDefaultBashTimeout(input);
			return handleBash(input.command, ctx);
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			return handleWritePath((event.input as { path: string }).path, ctx);
		}
		return undefined;
	});
}

function handleBash(command: string, ctx: ExtensionContext) {
	const safety = analyzeBash(command, ctx.cwd);
	if (safety.action === "block") {
		notify(ctx, `🛑 BLOCKED: ${safety.reason}`);
		return { block: true, reason: `Safeguard: ${safety.reason}` };
	}
	if (safety.action === "prompt") return promptOrBlock(ctx, command, safety.reason ?? "Risky command");
	return undefined;
}

function handleWritePath(targetPath: string, ctx: ExtensionContext) {
	const normalized = resolvePathForComparison(targetPath, ctx.cwd);
	for (const { pattern, reason } of HARD_BLOCK_PATHS) {
		if (pattern.test(normalized)) {
			notify(ctx, `🛑 BLOCKED: ${reason}`);
			return { block: true, reason: `Safeguard: ${reason}` };
		}
	}
	if (!isUnderCwd(targetPath, ctx.cwd)) {
		for (const { pattern, reason } of PROMPT_PATHS) {
			if (pattern.test(normalized)) return promptOrBlock(ctx, targetPath, reason);
		}
	}
	return undefined;
}

async function promptOrBlock(ctx: ExtensionContext, target: string, reason: string): Promise<{ block: true; reason: string } | undefined> {
	if (!ctx.hasUI) return { block: true, reason: `Safeguard: ${reason} (no UI for confirmation)` };
	const truncated = target.length > 120 ? `${target.slice(0, 120)}…` : target;
	try {
		const allowed = await ctx.ui.confirm(`⚠️ Safeguard: ${reason}`, `Allow?\n\n  ${truncated}`);
		return allowed ? undefined : { block: true, reason: `Safeguard: ${reason} (denied by user)` };
	} catch {
		return { block: true, reason: `Safeguard: ${reason} (confirmation failed)` };
	}
}

function notify(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
}
