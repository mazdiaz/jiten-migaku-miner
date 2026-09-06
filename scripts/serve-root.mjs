import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";
const DEFAULT_PORT = 8931;
const HOST = "127.0.0.1";

function parsePort(argv) {
  const flagIndex = argv.indexOf("--port");
  if (flagIndex !== -1 && argv[flagIndex + 1] !== undefined) {
    const port = Number.parseInt(argv[flagIndex + 1], 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  for (const arg of argv) {
    if (arg.startsWith("--port=")) {
      const port = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  }
  return DEFAULT_PORT;
}

function contentTypeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_MIME_TYPE;
}

function sendError(res, statusCode, reason) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `${statusCode} ${reason}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const root = process.cwd();
const port = parsePort(process.argv.slice(2));

async function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendError(res, 405, "Method Not Allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", `http://${HOST}`).pathname);
  } catch {
    sendError(res, 400, "Bad Request");
    return;
  }
  if (pathname.includes("\0")) {
    sendError(res, 400, "Bad Request");
    return;
  }

  const resolvedPath = resolve(root, `.${pathname}`);
  if (resolvedPath !== root && !resolvedPath.startsWith(root + sep)) {
    sendError(res, 403, "Forbidden");
    return;
  }

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch {
    sendError(res, 404, "Not Found");
    return;
  }

  let filePath = resolvedPath;
  if (stats.isDirectory()) {
    try {
      filePath = join(resolvedPath, "index.html");
      stats = await stat(filePath);
    } catch {
      sendError(res, 404, "Not Found");
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": stats.size,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => sendError(res, 500, "Internal Server Error"));
  stream.pipe(res);
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => sendError(res, 500, "Internal Server Error"));
});

server.on("error", (error) => {
  console.error(`serve-root failed to start on ${HOST}:${port}: ${error.message}`);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`serve-root listening on http://${HOST}:${port}/ (root: ${root})`);
});
