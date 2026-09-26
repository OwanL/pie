import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const serverPath = join(fixtureDirectory, "event-server.mjs");

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for fixture server readiness. stderr: ${stderr}`));
    }, 5_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n")[0];
      if (!line) return;
      try {
        const ready = JSON.parse(line);
        if (ready.event === "ready" && ready.host === "127.0.0.1" && Number.isInteger(ready.port)) {
          clearTimeout(timeout);
          resolve({ child, ready, getStdout: () => stdout, getStderr: () => stderr });
        }
      } catch {
        // Continue collecting until readiness timeout produces a useful error.
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!stdout.includes('"event":"ready"')) {
        reject(new Error(`Fixture server exited before readiness (${code ?? signal}). stderr: ${stderr}`));
      }
    });
  });
}

function request(port, path, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: encodedBody ? { "content-type": "application/json", "content-length": Buffer.byteLength(encodedBody) } : undefined,
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: data }));
    });
    req.once("error", reject);
    if (encodedBody) req.write(encodedBody);
    req.end();
  });
}

function stopServer(child) {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      // Windows implements child.kill("SIGTERM") as immediate termination, while
      // POSIX delivers it to the server's graceful shutdown handler.
      if ((code === 0 && signal === null) || signal === "SIGTERM") resolve();
      else reject(new Error(`Fixture server did not shut down (${code ?? signal})`));
    });
    child.kill("SIGTERM");
  });
}

test("event server distinguishes a no-op from a fixture-reported trusted action", async () => {
  const { child, ready, getStdout } = await startServer();
  try {
    assert.equal(ready.port > 0, true, "port 0 should resolve to an assigned TCP port");

    const dom = await request(ready.port, "/dom-fixture.html");
    assert.equal(dom.statusCode, 200);
    assert.match(dom.body, /isTrusted/);
    const canvas = await request(ready.port, "/canvas-fixture.html");
    assert.equal(canvas.statusCode, 200);
    assert.match(canvas.body, /canvasDevicePoint/);

    const before = await request(ready.port, "/events");
    assert.equal(before.statusCode, 200);
    assert.deepEqual(JSON.parse(before.body), { count: 0, events: [] }, "no browser action must not look successful");

    const posted = await request(ready.port, "/evt", {
      method: "POST",
      body: { fixture: "test", action: "click", isTrusted: true },
    });
    assert.equal(posted.statusCode, 201);
    const recorded = JSON.parse(posted.body).event;
    assert.equal(recorded.id, 1);
    assert.equal(recorded.isTrusted, true);
    assert.ok(recorded.receivedAt);

    const after = await request(ready.port, "/events");
    assert.equal(JSON.parse(after.body).count, 1, "only a reported action changes the event ledger");

    const reset = await request(ready.port, "/reset", { method: "POST" });
    assert.deepEqual(JSON.parse(reset.body), { ok: true, count: 0 });
    const resetAgain = await request(ready.port, "/reset");
    assert.deepEqual(JSON.parse(resetAgain.body), { ok: true, count: 0 });
    assert.equal(getStdout().trim().split("\n").length, 1, "readiness is the server's only stdout line");
  } finally {
    await stopServer(child);
  }
});
