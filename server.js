// Minimal zero-dependency static file server for brnstrm.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { initStorage, handleApi } = require("./storage");

const PORT = 8888;
const ROOT = path.join(__dirname, "src");

initStorage();

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  // Strip query string and normalize; default to index.html.
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  // Delegate the storage API; everything else is a static file.
  if (urlPath.startsWith("/api/")) {
    return handleApi(req, res, urlPath);
  }

  const relPath = urlPath === "/" ? "/index.html" : urlPath;

  // Resolve within ROOT and block path traversal.
  const filePath = path.join(ROOT, relPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`brnstrm running at http://localhost:${PORT}`);
});
