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
  saveBoardCamera: (id, camera) => req("PATCH", board(id), { camera }),
  getBoard: (id) => req("GET", board(id)),
  createNode: (id, node) => req("POST", board(id) + "/nodes", node),
  updateNode: (id, nodeId, patch) =>
    req("PATCH", board(id) + "/nodes/" + encodeURIComponent(nodeId), patch),
  deleteNode: (id, nodeId) =>
    req("DELETE", board(id) + "/nodes/" + encodeURIComponent(nodeId)),
};
