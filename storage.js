// Filesystem-backed storage mirror for brnstrm.
//
// Layout on disk (one folder per board, one file per node):
//   <STORAGE>/
//     <board-id>/
//       layout.json     -> { id, name, nodes: [{ id, x, y, w, h }] }
//       <node-id>.md     -> raw node content (a plain textarea for now)
//
// This is intentionally simple; node content/format will grow later.

const fs = require("fs");
const path = require("path");

// Global storage root. Override with BRNSTRM_DATA to mirror elsewhere.
const STORAGE = process.env.BRNSTRM_DATA || path.join(__dirname, "data");

function initStorage() {
  fs.mkdirSync(STORAGE, { recursive: true });
}

/* ---------- helpers ---------- */

// Folder/file segments are restricted to a safe slug charset; reject anything
// that could escape the storage root.
function safeSeg(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(s);
}

function slugify(name) {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "board"
  );
}

function boardDir(id) {
  return path.join(STORAGE, id);
}

function nodeFile(id, nodeId) {
  return path.join(boardDir(id), nodeId + ".md");
}

function readLayout(id) {
  return JSON.parse(fs.readFileSync(path.join(boardDir(id), "layout.json"), "utf8"));
}

function writeLayout(id, layout) {
  fs.writeFileSync(
    path.join(boardDir(id), "layout.json"),
    JSON.stringify(layout, null, 2)
  );
}

function nextNodeId(layout) {
  let max = 0;
  for (const n of layout.nodes) {
    const m = /^node-(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "node-" + (max + 1);
}

/* ---------- board operations ---------- */

function listBoards() {
  return fs
    .readdirSync(STORAGE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        const l = readLayout(d.name);
        return { id: l.id || d.name, name: l.name || d.name };
      } catch (_) {
        return { id: d.name, name: d.name };
      }
    });
}

function createBoard(name) {
  const slug = slugify(name);
  let id = slug;
  let i = 2;
  while (fs.existsSync(boardDir(id))) id = slug + "-" + i++;
  fs.mkdirSync(boardDir(id), { recursive: true });
  const layout = { id, name: String(name || "").trim() || "untitled board", nodes: [] };
  writeLayout(id, layout);
  return { id, name: layout.name };
}

function renameBoard(id, name) {
  const layout = readLayout(id);
  layout.name = String(name || "").trim() || layout.name;
  writeLayout(id, layout);
  return { id, name: layout.name };
}

function saveCameraPosition(id, camera) {
  const layout = readLayout(id);
  layout.camera = {
    x: Number(camera.x) || 0,
    y: Number(camera.y) || 0,
    scale: Number(camera.scale) || 1,
  };
  writeLayout(id, layout);
  return { ok: true };
}

function getBoard(id) {
  const layout = readLayout(id);
  const nodes = layout.nodes.map((n) => {
    let content = "";
    try {
      content = fs.readFileSync(nodeFile(id, n.id), "utf8");
    } catch (_) {}
    return { ...n, content };
  });
  return { id: layout.id || id, name: layout.name, camera: layout.camera || null, nodes };
}

/* ---------- node operations ---------- */

function createNode(id, data) {
  const layout = readLayout(id);
  // Normally auto-assign the next id. An explicit id (used by undo to restore a
  // just-deleted node) is honored when it's a safe slug and not already taken.
  let nodeId = nextNodeId(layout);
  if (
    typeof data.id === "string" &&
    safeSeg(data.id) &&
    !layout.nodes.some((n) => n.id === data.id)
  ) {
    nodeId = data.id;
  }
  const node = {
    id: nodeId,
    x: Math.round(data.x || 0),
    y: Math.round(data.y || 0),
    w: Math.round(data.w || 220),
    h: Math.round(data.h || 140),
  };
  layout.nodes.push(node);
  const content = typeof data.content === "string" ? data.content : "";
  fs.writeFileSync(nodeFile(id, node.id), content);
  writeLayout(id, layout);
  return { ...node, content };
}

function updateNode(id, nodeId, patch) {
  const layout = readLayout(id);
  const node = layout.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("node not found");
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof patch[key] === "number") node[key] = Math.round(patch[key]);
  }
  if (typeof patch.content === "string") {
    fs.writeFileSync(nodeFile(id, nodeId), patch.content);
  }
  writeLayout(id, layout);
  return { ok: true };
}

function deleteNode(id, nodeId) {
  const layout = readLayout(id);
  layout.nodes = layout.nodes.filter((n) => n.id !== nodeId);
  writeLayout(id, layout);
  try {
    fs.unlinkSync(nodeFile(id, nodeId));
  } catch (_) {}
  return { ok: true };
}

/* ---------- HTTP routing ---------- */

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Routes (pathname already stripped of query string):
//   GET    /api/boards
//   POST   /api/boards                       { name }
//   GET    /api/boards/:id
//   PATCH  /api/boards/:id                    { name }
//   POST   /api/boards/:id/nodes             { x, y, w?, h? }
//   PATCH  /api/boards/:id/nodes/:nodeId     { x?, y?, w?, h?, content? }
//   DELETE /api/boards/:id/nodes/:nodeId
async function handleApi(req, res, pathname) {
  const seg = pathname.split("/").filter(Boolean); // ["api","boards",...]
  const method = req.method;

  try {
    // /api/boards
    if (seg.length === 2 && seg[1] === "boards") {
      if (method === "GET") return sendJson(res, 200, listBoards());
      if (method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 201, createBoard(body.name));
      }
    }

    // /api/boards/:id
    if (seg.length === 3 && seg[1] === "boards") {
      const id = seg[2];
      if (!safeSeg(id) || !fs.existsSync(boardDir(id)))
        return sendJson(res, 404, { error: "board not found" });
      if (method === "GET") return sendJson(res, 200, getBoard(id));
      if (method === "PATCH") {
        const body = await readBody(req);
        if (body.camera && typeof body.camera.x === "number") {
          return sendJson(res, 200, saveCameraPosition(id, body.camera));
        }
        return sendJson(res, 200, renameBoard(id, body.name));
      }
    }

    // /api/boards/:id/nodes
    if (seg.length === 4 && seg[1] === "boards" && seg[3] === "nodes") {
      const id = seg[2];
      if (!safeSeg(id) || !fs.existsSync(boardDir(id)))
        return sendJson(res, 404, { error: "board not found" });
      if (method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 201, createNode(id, body));
      }
    }

    // /api/boards/:id/nodes/:nodeId
    if (seg.length === 5 && seg[1] === "boards" && seg[3] === "nodes") {
      const id = seg[2];
      const nodeId = seg[4];
      if (!safeSeg(id) || !safeSeg(nodeId))
        return sendJson(res, 404, { error: "not found" });
      if (method === "PATCH") {
        const body = await readBody(req);
        return sendJson(res, 200, updateNode(id, nodeId, body));
      }
      if (method === "DELETE") return sendJson(res, 200, deleteNode(id, nodeId));
    }

    return sendJson(res, 404, { error: "unknown route" });
  } catch (err) {
    return sendJson(res, 500, { error: String(err.message || err) });
  }
}

module.exports = { STORAGE, initStorage, handleApi };
