import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/utils/tools-manager.ts", () => ({
	ensureTool: vi.fn(async (name: string) => name),
}));

beforeEach(() => {
	mocks.spawn.mockReset();
	mocks.spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			killed: false,
			kill: vi.fn(),
		});
		setImmediate(() => {
			child.stdout.end();
			child.stderr.end();
			child.emit("exit", 0);
			child.emit("close", 0);
		});
		return child;
	});
});

describe("background spawn options", () => {
	it("hides extension command processes without changing cwd, shell or stdio", async () => {
		await expect(execCommand("command", ["arg"], process.cwd())).resolves.toEqual({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		});
		expect(mocks.spawn).toHaveBeenCalledWith("command", ["arg"], {
			cwd: process.cwd(),
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	});

	it("hides fd listing and Windows path-glob validation processes", async () => {
		await createFindTool(process.cwd()).execute("find", { pattern: "src/**/*.ts" });
		expect(mocks.spawn).toHaveBeenCalledTimes(process.platform === "win32" ? 2 : 1);
		for (const [command, , options] of mocks.spawn.mock.calls) {
			expect(command).toBe("fd");
			expect(options).toEqual({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		}
	});

	it("hides ripgrep processes", async () => {
		await createGrepTool(process.cwd()).execute("grep", { pattern: "needle" });
		expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith("rg", expect.any(Array), {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	});
});
