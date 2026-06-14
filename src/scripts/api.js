// Thin client for the storage API.

async function req(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  if (!res.ok) throw new Error(method + " " + url + " -> " + res.status);
  return res.json();
}

const board = (id) => "/api/boards/" + encodeURIComponent(id);

export const api = {
  listBoards: () => req("GET", "/api/boards"),
  createBoard: (name) => req("POST", "/api/boards", { name }),
  renameBoard: (id, name) => req("PATCH", board(id), { name }),
  deleteBoard: (id) => req("DELETE", board(id)),
  saveBoardCamera: (id, camera) => req("PATCH", board(id), { camera }),
  getBoard: (id) => req("GET", board(id)),
  createNode: (id, node) => req("POST", board(id) + "/nodes", node),
  updateNode: (id, nodeId, patch) =>
    req("PATCH", board(id) + "/nodes/" + encodeURIComponent(nodeId), patch),
  // Renaming a node re-slugs its .md file server-side; the node id is unchanged.
  renameNode: (id, nodeId, name) =>
    req("PATCH", board(id) + "/nodes/" + encodeURIComponent(nodeId), { name }),
  deleteNode: (id, nodeId) =>
    req("DELETE", board(id) + "/nodes/" + encodeURIComponent(nodeId)),

  createSection: (id, section) => req("POST", board(id) + "/sections", section),
  updateSection: (id, sectionId, patch) =>
    req("PATCH", board(id) + "/sections/" + encodeURIComponent(sectionId), patch),
  deleteSection: (id, sectionId) =>
    req("DELETE", board(id) + "/sections/" + encodeURIComponent(sectionId)),

  // Upload a dragged-in File to the board's resources folder. Raw bytes in the
  // body; the filename rides in a header so it survives unicode/spaces.
  listResources: (id) => req("GET", board(id) + "/resources"),
  // Stable URL the browser can use to fetch a stored resource (image <img> src,
  // or open-in-new-tab for other file types).
  resourceUrl: (id, name) =>
    board(id) + "/resources/" + encodeURIComponent(name),
  uploadResource: async (id, file) => {
    const res = await fetch(board(id) + "/resources", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!res.ok) throw new Error("upload " + file.name + " -> " + res.status);
    return res.json();
  },

  listConnections: (id) => req("GET", board(id) + "/connections"),
  createConnection: (id, conn) => req("POST", board(id) + "/connections", conn),
  updateConnection: (id, connId, patch) =>
    req("PATCH", board(id) + "/connections/" + encodeURIComponent(connId), patch),
  deleteConnection: (id, connId) =>
    req("DELETE", board(id) + "/connections/" + encodeURIComponent(connId)),
};
