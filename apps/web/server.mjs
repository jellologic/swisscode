// Production entry: serves the Start fetch-handler bundle on Node's http.
// Run `npm run build` first, then `npm start` ( honors PORT, default 3000 ).
import { createServer } from "node:http";
import server from "./dist/server/server.js";

const port = Number(process.env["PORT"] ?? 3000);

createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url}`;
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
}).listen(port, () => {
  console.log(`swisscode web listening on http://localhost:${port}`);
});
