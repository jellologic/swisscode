// Production entry: serves the Start fetch-handler bundle on Node's http.
// Run `npm run build` first, then `npm start` ( honors PORT, default 3000 ).
//
// Binds loopback and answers only for a local Host (see hostGuard.mjs): this
// UI has no login and every route can read stored credentials.
import { createServer } from "node:http";
import server from "./dist/server/server.js";
import { isAllowedHost, webHost } from "./hostGuard.mjs";

const port = Number(process.env["PORT"] ?? 3000);
const host = webHost();

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
