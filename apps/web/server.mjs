// Production entry: serves the Start fetch-handler bundle on Node's http.
// Run `npm run build` first, then `npm start` ( honors PORT, default 8124 ).
//
// Binds loopback and answers only for a local Host (see hostGuard.mjs): this
// UI has no login and every route can read stored credentials.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import server from "./dist/server/server.js";
import { isAllowedHost, webHost } from "./hostGuard.mjs";

const port = Number(process.env["PORT"] ?? 8124);
const host = webHost();

// The Start server bundle renders routes but does not serve its own client
// output: without this, /assets/*.css|js 404 and the UI arrives unstyled and
// inert. Anything that is not a real file under dist/client falls through to
// the framework handler, so routing and 404s stay the framework's job.
const clientDir = fileURLToPath(new URL("./dist/client/", import.meta.url));

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** File bytes for GET/HEAD asset paths, or null to let the framework answer. */
async function clientAsset(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  // Traversal, absolute paths, and dotfiles never map into the client dir.
  if (!rel || rel === "." || rel.startsWith("..") || rel.split(sep).some((p) => p.startsWith("."))) {
    return null;
  }
  const file = fileURLToPath(new URL(`./dist/client/${rel}`, import.meta.url));
  if (!file.startsWith(clientDir)) return null;
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  return readFile(file);
}

createServer(async (req, res) => {
  try {
    const hostHeader = req.headers.host;
    // Before routing: a spoofed Host both picks the origin the framework's
    // CSRF check compares against and becomes the URL the router sees.
    if (!isAllowedHost(hostHeader, host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("swisscode web only answers on localhost");
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && req.url) {
      const pathname = req.url.split("?", 1)[0];
      const body = await clientAsset(pathname);
      if (body !== null) {
        const headers = {
          "Content-Type": CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": body.length,
        };
        // Vite hashes asset filenames, so a served /assets/* file is immutable.
        if (pathname.startsWith("/assets/")) {
          headers["Cache-Control"] = "public, max-age=31536000, immutable";
        }
        res.writeHead(200, headers);
        if (req.method === "GET") res.write(body);
        res.end();
        return;
      }
    }
    const url = `http://${hostHeader ?? `localhost:${port}`}${req.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody
      ? await new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", (d) => chunks.push(d));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
        })
      : undefined;
    const response = await server.fetch(new Request(url, { method: req.method, headers, body }));
    const outHeaders = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    res.writeHead(response.status, outHeaders);
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("internal error");
  }
}).listen(port, host, () => {
  console.log(`swisscode web listening on http://${host}:${port}`);
});
