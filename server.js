import { createReadStream, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const port = process.env.PORT || 4173;
const host = "127.0.0.1";

createServer((req, res) => {
  const cleanPath = new URL(req.url, "http://localhost").pathname === "/"
    ? "/index.html"
    : new URL(req.url, "http://localhost").pathname;
  const file = resolve(join(root, cleanPath));

  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, host, () => {
  console.log(`AI Hominem running at http://${host}:${port}`);
});
