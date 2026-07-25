import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const MAX_EVENT_BYTES = 256 * 1024;
const fixtureFiles = new Map([
  ["/", "dom-fixture.html"],
  ["/dom-fixture.html", "dom-fixture.html"],
  ["/canvas-fixture.html", "canvas-fixture.html"],
]);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendText(response, statusCode, value, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  response.end(value);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_EVENT_BYTES) {
      throw new Error("Event body exceeds 256 KiB");
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    throw new Error("Event body is required");
  }

  const value = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Event body must be a JSON object");
  }
  return value;
}

function parsePort(argv) {
  const equalsArgument = argv.find((argument) => argument.startsWith("--port="));
  const portIndex = argv.indexOf("--port");
  const value = equalsArgument
    ? equalsArgument.slice("--port=".length)
    : (portIndex === -1 ? process.env.PORT : argv[portIndex + 1]) ?? "0";
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

/**
 * Creates the dependency-free fixture server without listening. Tests may use
 * this directly; normal fixture use starts this file as a process.
 */
export function createEventServer() {
  let events = [];
  let nextEventId = 1;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    const fixtureFile = fixtureFiles.get(url.pathname);

    if (request.method === "GET" && fixtureFile) {
      const html = await readFile(new URL(fixtureFile, import.meta.url), "utf8");
      sendText(response, 200, html, "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/events") {
      if (request.method !== "GET") {
        sendText(response, 405, "Method Not Allowed\n");
        return;
      }
      sendJson(response, 200, { count: events.length, events });
      return;
    }

    if (url.pathname === "/reset") {
      if (request.method !== "GET" && request.method !== "POST") {
        sendText(response, 405, "Method Not Allowed\n");
        return;
      }
      events = [];
      nextEventId = 1;
      sendJson(response, 200, { ok: true, count: 0 });
      return;
    }

    if (url.pathname === "/evt") {
      if (request.method !== "POST") {
        sendText(response, 405, "Method Not Allowed\n");
        return;
      }
      const event = await readJson(request);
      const recorded = {
        ...event,
        id: nextEventId++,
        receivedAt: new Date().toISOString(),
      };
      events.push(recorded);
      sendJson(response, 201, { ok: true, event: recorded, count: events.length });
      return;
    }

    sendText(response, 404, "Not Found\n");
  }

  return server;
}

export async function startEventServer(port = 0) {
  const server = createEventServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function main() {
  const server = await startEventServer(parsePort(process.argv.slice(2)));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP address");
  }

  // This is deliberately the only stdout line: runners parse it to discover a port-0 binding.
  process.stdout.write(`${JSON.stringify({ event: "ready", host: HOST, port: address.port })}\n`);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
