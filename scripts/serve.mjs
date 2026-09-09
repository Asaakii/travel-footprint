#!/usr/bin/env node
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });
const dist = resolve(root, "dist");
const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const port = Number(process.env.PORT || 4173);

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  let file = normalize(join(dist, pathname));
  if (!file.startsWith(dist)) return response.writeHead(403).end();
  if (existsSync(file) && (await stat(file)).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) file = join(dist, "index.html");
  response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`Travel Footprint: http://localhost:${port}`));
