// Filesystem-backed storage mirror for brnstrm.
//
// Layout on disk (one folder per board, one file per node):
//   <STORAGE>/
//     <board-name>/          -> folder named after the board's display name
//       layout.json          -> { id, name, nodes: [...], sections: [...] }
//       connections.json     -> { connections: [{ id, from, to, label }] }
//       <node-name>.md        -> raw node content (a plain textarea for now)
//       <section-name>/       -> a section is a folder; node files for nodes that
//         <node-name>.md          fall fully inside the section live in here
//
// Naming: every board/section/node carries a stable id (used for all cross-
// references — connections point at node ids, the board id is the URL key) plus
// a display name. The on-disk folder/file *name* mirrors the display name as a
// slug (collisions get a -2 suffix), so renaming a thing renames its folder/file
// without disturbing any reference. Unnamed things fall back to their id as the
// slug. The mapping from id to on-disk name lives in layout.json.
//
// Sections mirror the visual grouping into the filesystem: a node whose box is
// fully contained by a section's box has its .md file moved into that section's
// folder (smallest containing section wins). reconcileSections() keeps the tree
// in sync after any geometry change. This is intentionally simple; node
// content/format will grow later.

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

function slugify(name, fallback = "board") {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

// Append -2, -3, … until the slug is free among `taken`.
function uniqueSlug(base, taken) {
  let slug = base;
  let i = 2;
  while (taken.has(slug)) slug = base + "-" + i++;
  return slug;
}

function readLayoutAt(dirName) {
  return JSON.parse(
    fs.readFileSync(path.join(STORAGE, dirName, "layout.json"), "utf8")
  );
}

function writeLayoutAt(dirName, layout) {
  fs.writeFileSync(
    path.join(STORAGE, dirName, "layout.json"),
    JSON.stringify(layout, null, 2)
  );
}

// Every board on disk, mapping its stable id to the folder that holds it. The
// folder name mirrors the board's display name and so can drift from the id
// after a rename — every board lookup resolves through here.
function boardEntries() {
  let entries = [];
  try {
    entries = fs.readdirSync(STORAGE, { withFileTypes: true });
  } catch (_) {}
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    try {
      const l = readLayoutAt(d.name);
      out.push({ dir: d.name, id: l.id || d.name, name: l.name || d.name });
    } catch (_) {
      out.push({ dir: d.name, id: d.name, name: d.name });
    }
  }
  return out;
}

function boardDirName(id) {
  const hit = boardEntries().find((e) => e.id === id);
  return hit ? hit.dir : id; // fall back to id (legacy folders are named by id)
}

function boardExists(id) {
  return boardEntries().some((e) => e.id === id);
}

function boardDir(id) {
  return path.join(STORAGE, boardDirName(id));
}

function readLayout(id) {
  return readLayoutAt(boardDirName(id));
}

function writeLayout(id, layout) {
  writeLayoutAt(boardDirName(id), layout);
}

function nextNodeId(layout) {
  let max = 0;
  for (const n of layout.nodes) {
    const m = /^node-(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "node-" + (max + 1);
}

/* ---------- section geometry & filesystem mirroring ---------- */

function sectionsOf(layout) {
  return Array.isArray(layout.sections) ? layout.sections : [];
}

// On-disk basenames mirror display names but fall back to the stable id when a
// thing is unnamed (or predates names existing).
function nodeStem(n) {
  return n.slug || n.id;
}
function sectionSlug(s) {
  return s.slug || s.id;
}

function rectArea(r) {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

// A node or section is "in" another section only when its whole box is inside.
function sectionContains(s, n) {
  return (
    n.x >= s.x &&
    n.y >= s.y &&
    n.x + n.w <= s.x + s.w &&
    n.y + n.h <= s.y + s.h
  );
}

// Build a map of sectionId -> absolute expected folder path, accounting for
// nesting (a section whose box is fully inside another section becomes a
// subfolder of that section's folder).
function buildSectionPaths(boardId, layout) {
  const sections = sectionsOf(layout);
  const root = boardDir(boardId);

  // For each section find its parent: the smallest section that fully contains it.
  const parentOf = new Map();
  for (const s of sections) {
    const containing = sections.filter(
      (p) => p.id !== s.id && sectionContains(p, s)
    );
    if (!containing.length) {
      parentOf.set(s.id, null);
    } else {
      containing.sort(
        (a, b) => rectArea(a) - rectArea(b) || a.id.localeCompare(b.id)
      );
      parentOf.set(s.id, containing[0]);
    }
  }

  const pathMap = new Map();

  function getPath(s, visited = new Set()) {
    if (pathMap.has(s.id)) return pathMap.get(s.id);
    if (visited.has(s.id)) {
      // Cycle guard (e.g. two equal-sized overlapping sections) — put at root.
      const p = path.join(root, sectionSlug(s));
      pathMap.set(s.id, p);
      return p;
    }
    visited.add(s.id);
    const parent = parentOf.get(s.id);
    const p = parent
      ? path.join(getPath(parent, visited), sectionSlug(s))
      : path.join(root, sectionSlug(s));
    pathMap.set(s.id, p);
    return p;
  }

  for (const s of sections) getPath(s);
  return pathMap;
}

// Where a node's .md file should live: the innermost (smallest) section that
// fully contains it, or the board root when no section does.
// Pass a pre-built pathMap to avoid recomputing it when called in a loop.
function targetDirForNode(boardId, layout, node, pathMap) {
  const containing = sectionsOf(layout).filter((s) => sectionContains(s, node));
  if (!containing.length) return boardDir(boardId);
  containing.sort((a, b) => rectArea(a) - rectArea(b) || a.id.localeCompare(b.id));
  const inner = containing[0];
  const map = pathMap || buildSectionPaths(boardId, layout);
  return map.get(inner.id) || boardDir(boardId);
}

// Locate a node's .md file by stem, searching the entire board directory tree.
function findNodeFile(boardId, stem) {
  const root = boardDir(boardId);

  function search(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return null;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === stem + ".md") return path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = search(path.join(dir, e.name));
        if (found) return found;
      }
    }
    return null;
  }

  return search(root);
}

// Locate a section folder by its slug, searching the entire board directory tree.
function findSectionDir(boardId, slug) {
  const root = boardDir(boardId);

  function search(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === slug) return path.join(dir, e.name);
      const found = search(path.join(dir, e.name));
      if (found) return found;
    }
    return null;
  }

  return search(root);
}

// Make the on-disk folder tree match the current sections/nodes.
//
// Sections nest: a section whose box is fully inside another section's box
// becomes a subfolder of that section's folder. The algorithm:
//   1. Compute the expected absolute path for every section folder.
//   2. Sort sections shallowest-first so a parent folder exists before its
//      children are placed inside it (and a renamed parent drags children along
//      when its folder is renamed with fs.renameSync).
//   3. Move or create each section folder.
//   4. Move each node file into its target folder.
//   5. Remove stale folders (relocating any loose files back to the board root).
function reconcileSections(boardId, layout) {
  const root = boardDir(boardId);
  const sections = sectionsOf(layout);
  const pathMap = buildSectionPaths(boardId, layout);

  // Sort by expected path depth (fewer segments = shallower = process first).
  const rootDepth = root.split(path.sep).length;
  const pathDepth = (s) => pathMap.get(s.id).split(path.sep).length - rootDepth;
  const sorted = [...sections].sort((a, b) => pathDepth(a) - pathDepth(b));

  // Phase 1: move or create each section's folder.
  for (const s of sorted) {
    const expected = pathMap.get(s.id);
    const current = findSectionDir(boardId, sectionSlug(s));
    if (current) {
      if (path.resolve(current) !== path.resolve(expected)) {
        try {
          fs.mkdirSync(path.dirname(expected), { recursive: true });
          fs.renameSync(current, expected);
        } catch (_) {}
      }
    } else {
      try {
        fs.mkdirSync(expected, { recursive: true });
      } catch (_) {}
    }
  }

  // Phase 2: move each node file to its target folder.
  for (const node of layout.nodes) {
    const stem = nodeStem(node);
    const target = path.join(targetDirForNode(boardId, layout, node, pathMap), stem + ".md");
    const current = findNodeFile(boardId, stem);
    if (current && path.resolve(current) !== path.resolve(target)) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(current, target);
      } catch (_) {}
    }
  }

  // Phase 3: remove stale folders (directories whose name is not a valid
  // section slug). Loose files are relocated to the board root first; then
  // fs.rmdirSync removes the directory only when it is empty (silently
  // fails if a valid nested section is still inside — next reconcile cleans up).
  const validSlugs = new Set(sections.map(sectionSlug));

  function cleanDir(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      if (!validSlugs.has(e.name)) {
        let contents = [];
        try {
          contents = fs.readdirSync(sub, { withFileTypes: true });
        } catch (_) {}
        for (const f of contents) {
          if (f.isFile()) {
            try {
              fs.renameSync(path.join(sub, f.name), path.join(root, f.name));
            } catch (_) {}
          }
        }
        try {
          fs.rmdirSync(sub);
        } catch (_) {}
      } else {
        cleanDir(sub);
      }
    }
  }

  cleanDir(root);
}

function nextSectionId(layout) {
  let max = 0;
  for (const s of sectionsOf(layout)) {
    const m = /^section-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "section-" + (max + 1);
}

/* ---------- connections (arrows) — stored in connections.json ---------- */

function connFile(id) {
  return path.join(boardDir(id), "connections.json");
}

function readConnections(id) {
  try {
    const data = JSON.parse(fs.readFileSync(connFile(id), "utf8"));
    if (Array.isArray(data.connections)) return data;
  } catch (_) {}
  return { connections: [] };
}

function writeConnections(id, data) {
  fs.writeFileSync(connFile(id), JSON.stringify(data, null, 2));
}

function nextConnId(data) {
  let max = 0;
  for (const c of data.connections) {
    const m = /^conn-(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "conn-" + (max + 1);
}

/* ---------- board operations ---------- */

function listBoards() {
  return boardEntries().map((e) => ({ id: e.id, name: e.name }));
}

function createBoard(name) {
  const entries = boardEntries();
  // On creation the id and the folder match; keep both clear of every existing
  // id *and* folder so a later rename can't collide them.
  const taken = new Set([...entries.map((e) => e.id), ...entries.map((e) => e.dir)]);
  const slug = uniqueSlug(slugify(name), taken);
  fs.mkdirSync(path.join(STORAGE, slug), { recursive: true });
  const layout = {
    id: slug,
    name: String(name || "").trim() || "untitled board",
    nodes: [],
  };
  writeLayoutAt(slug, layout);
  return { id: slug, name: layout.name };
}

function renameBoard(id, name) {
  const dir = boardDirName(id);
  const layout = readLayoutAt(dir);
  layout.name = String(name || "").trim() || layout.name;
  writeLayoutAt(dir, layout);
  // Mirror the new name onto the folder, keeping the id (and thus every
  // reference and the open client) stable.
  const taken = new Set(boardEntries().filter((e) => e.id !== id).map((e) => e.dir));
  const newDir = uniqueSlug(slugify(layout.name), taken);
  if (newDir !== dir) {
    try {
      fs.renameSync(path.join(STORAGE, dir), path.join(STORAGE, newDir));
    } catch (_) {}
  }
  return { id, name: layout.name };
}

function deleteBoard(id) {
  const dir = boardDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
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
    const file = findNodeFile(id, nodeStem(n));
    if (file) {
      try {
        content = fs.readFileSync(file, "utf8");
      } catch (_) {}
    }
    return { ...n, content };
  });
  return {
    id: layout.id || id,
    name: layout.name,
    camera: layout.camera || null,
    nodes,
    sections: sectionsOf(layout),
    connections: readConnections(id).connections,
  };
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
  // Display name is optional; its slug names the .md file (unique board-wide so
  // files never clash as nodes move between section folders).
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const taken = new Set(layout.nodes.map(nodeStem));
  const node = {
    id: nodeId,
    name,
    slug: uniqueSlug(slugify(name, nodeId), taken),
    x: Math.round(data.x || 0),
    y: Math.round(data.y || 0),
    w: Math.round(data.w || 220),
    h: Math.round(data.h || 140),
  };
  layout.nodes.push(node);
  writeLayout(id, layout);
  const content = typeof data.content === "string" ? data.content : "";
  const dir = targetDirForNode(id, layout, node);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  fs.writeFileSync(path.join(dir, node.slug + ".md"), content);
  reconcileSections(id, layout);
  return { ...node, content };
}

function updateNode(id, nodeId, patch) {
  const layout = readLayout(id);
  const node = layout.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("node not found");
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof patch[key] === "number") node[key] = Math.round(patch[key]);
  }
  // Renaming re-slugs the node's .md file. References use the stable id, so
  // only the file on disk has to move.
  if (typeof patch.name === "string") {
    const oldStem = nodeStem(node);
    node.name = patch.name.trim();
    const taken = new Set(
      layout.nodes.filter((n) => n.id !== nodeId).map(nodeStem)
    );
    node.slug = uniqueSlug(slugify(node.name, node.id), taken);
    if (node.slug !== oldStem) {
      const cur = findNodeFile(id, oldStem);
      if (cur) {
        try {
          fs.renameSync(cur, path.join(path.dirname(cur), node.slug + ".md"));
        } catch (_) {}
      }
    }
  }
  writeLayout(id, layout);
  if (typeof patch.content === "string") {
    // Write to wherever the file currently lives; reconcile relocates after.
    const stem = nodeStem(node);
    const file =
      findNodeFile(id, stem) ||
      path.join(targetDirForNode(id, layout, node), stem + ".md");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (_) {}
    fs.writeFileSync(file, patch.content);
  }
  // Geometry may have changed which section a node falls in — re-sync folders.
  reconcileSections(id, layout);
  return { ok: true };
}

function deleteNode(id, nodeId) {
  const layout = readLayout(id);
  const node = layout.nodes.find((n) => n.id === nodeId);
  layout.nodes = layout.nodes.filter((n) => n.id !== nodeId);
  writeLayout(id, layout);
  const file = node && findNodeFile(id, nodeStem(node));
  if (file) {
    try {
      fs.unlinkSync(file);
    } catch (_) {}
  }
  pruneConnections(id, nodeId); // drop arrows that referenced the node
  reconcileSections(id, layout);
  return { ok: true };
}

/* ---------- section operations ---------- */

function createSection(id, data) {
  const layout = readLayout(id);
  if (!Array.isArray(layout.sections)) layout.sections = [];
  let sectionId = nextSectionId(layout);
  // An explicit id (used by undo to restore a just-deleted section) is honored
  // when it's a safe slug and free.
  if (
    typeof data.id === "string" &&
    safeSeg(data.id) &&
    !layout.sections.some((s) => s.id === data.id)
  ) {
    sectionId = data.id;
  }
  const label =
    typeof data.label === "string" && data.label.trim() ? data.label : "section";
  const taken = new Set(sectionsOf(layout).map(sectionSlug));
  const section = {
    id: sectionId,
    x: Math.round(data.x || 0),
    y: Math.round(data.y || 0),
    w: Math.round(data.w || 240),
    h: Math.round(data.h || 180),
    label,
    // The label slug names the section's folder on disk.
    slug: uniqueSlug(slugify(label, sectionId), taken),
  };
  layout.sections.push(section);
  writeLayout(id, layout);
  reconcileSections(id, layout);
  return section;
}

function updateSection(id, sectionId, patch) {
  const layout = readLayout(id);
  const section = sectionsOf(layout).find((s) => s.id === sectionId);
  if (!section) throw new Error("section not found");
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof patch[key] === "number") section[key] = Math.round(patch[key]);
  }
  // Relabelling re-slugs the section folder; reconcile then renames it on disk
  // and carries the contained node files across.
  if (typeof patch.label === "string") {
    section.label = patch.label;
    const taken = new Set(
      sectionsOf(layout).filter((s) => s.id !== sectionId).map(sectionSlug)
    );
    section.slug = uniqueSlug(slugify(section.label, section.id), taken);
  }
  writeLayout(id, layout);
  reconcileSections(id, layout);
  return { ok: true };
}

function deleteSection(id, sectionId) {
  const layout = readLayout(id);
  layout.sections = sectionsOf(layout).filter((s) => s.id !== sectionId);
  writeLayout(id, layout);
  // reconcile moves any nodes that were inside back out, then removes the folder.
  reconcileSections(id, layout);
  return { ok: true };
}

/* ---------- connection operations ---------- */

function createConnection(id, data) {
  const conns = readConnections(id);
  const conn = {
    id: nextConnId(conns),
    from: String(data.from || ""),
    to: String(data.to || ""),
    label: typeof data.label === "string" ? data.label : "",
  };
  if (
    typeof data.id === "string" &&
    safeSeg(data.id) &&
    !conns.connections.some((c) => c.id === data.id)
  ) {
    conn.id = data.id;
  }
  conns.connections.push(conn);
  writeConnections(id, conns);
  return conn;
}

function updateConnection(id, connId, patch) {
  const conns = readConnections(id);
  const conn = conns.connections.find((c) => c.id === connId);
  if (!conn) throw new Error("connection not found");
  if (typeof patch.label === "string") conn.label = patch.label;
  writeConnections(id, conns);
  return { ok: true };
}

function deleteConnection(id, connId) {
  const conns = readConnections(id);
  conns.connections = conns.connections.filter((c) => c.id !== connId);
  writeConnections(id, conns);
  return { ok: true };
}

// Remove any connections that reference a node (called when the node is deleted).
function pruneConnections(id, nodeId) {
  const conns = readConnections(id);
  const before = conns.connections.length;
  conns.connections = conns.connections.filter(
    (c) => c.from !== nodeId && c.to !== nodeId
  );
  if (conns.connections.length !== before) writeConnections(id, conns);
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
//   POST   /api/boards                              { name }
//   GET    /api/boards/:id
//   PATCH  /api/boards/:id                           { name }
//   POST   /api/boards/:id/nodes                    { x, y, w?, h? }
//   PATCH  /api/boards/:id/nodes/:nodeId            { x?, y?, w?, h?, content?, name? }
//   DELETE /api/boards/:id/nodes/:nodeId
//   POST   /api/boards/:id/sections                { x, y, w, h, label? }
//   PATCH  /api/boards/:id/sections/:sectionId     { x?, y?, w?, h?, label? }
//   DELETE /api/boards/:id/sections/:sectionId
//   GET    /api/boards/:id/connections
//   POST   /api/boards/:id/connections             { from, to, label? }
//   PATCH  /api/boards/:id/connections/:connId     { label? }
//   DELETE /api/boards/:id/connections/:connId
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
      if (method === "DELETE") return sendJson(res, 200, deleteBoard(id));
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

    // /api/boards/:id/sections
    if (seg.length === 4 && seg[1] === "boards" && seg[3] === "sections") {
      const id = seg[2];
      if (!safeSeg(id) || !fs.existsSync(boardDir(id)))
        return sendJson(res, 404, { error: "board not found" });
      if (method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 201, createSection(id, body));
      }
    }

    // /api/boards/:id/sections/:sectionId
    if (seg.length === 5 && seg[1] === "boards" && seg[3] === "sections") {
      const id = seg[2];
      const sectionId = seg[4];
      if (!safeSeg(id) || !safeSeg(sectionId))
        return sendJson(res, 404, { error: "not found" });
      if (method === "PATCH") {
        const body = await readBody(req);
        return sendJson(res, 200, updateSection(id, sectionId, body));
      }
      if (method === "DELETE") return sendJson(res, 200, deleteSection(id, sectionId));
    }

    // /api/boards/:id/connections
    if (seg.length === 4 && seg[1] === "boards" && seg[3] === "connections") {
      const id = seg[2];
      if (!safeSeg(id) || !fs.existsSync(boardDir(id)))
        return sendJson(res, 404, { error: "board not found" });
      if (method === "GET") return sendJson(res, 200, readConnections(id).connections);
      if (method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 201, createConnection(id, body));
      }
    }

    // /api/boards/:id/connections/:connId
    if (seg.length === 5 && seg[1] === "boards" && seg[3] === "connections") {
      const id = seg[2];
      const connId = seg[4];
      if (!safeSeg(id) || !safeSeg(connId))
        return sendJson(res, 404, { error: "not found" });
      if (method === "PATCH") {
        const body = await readBody(req);
        return sendJson(res, 200, updateConnection(id, connId, body));
      }
      if (method === "DELETE") return sendJson(res, 200, deleteConnection(id, connId));
    }

    return sendJson(res, 404, { error: "unknown route" });
  } catch (err) {
    return sendJson(res, 500, { error: String(err.message || err) });
  }
}

module.exports = { STORAGE, initStorage, handleApi };
