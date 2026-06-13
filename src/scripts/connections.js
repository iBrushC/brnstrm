// Connection layer — straight arrows that link two nodes and carry a relationship
// label. Picked from the right of the radial menu: enter "connect" mode, click a
// source node, then a target node. Connections are non-hierarchical and live in
// their own connections.json (see storage.js), independent of the node tree.
//
// Each connection draws an SVG <line> (with an arrowhead marker) plus an HTML
// label at the midpoint. Both live inside the (transformed) viewport, so they
// pan/zoom in world space alongside the nodes. redraw() recomputes endpoints
// from the live node rects, so arrows follow nodes as they move.

import { api } from "./api.js";
import { screenToWorld } from "./view.js";

export function createConnectionLayer({
  svg,
  labelLayer,
  canvas,
  getBoardId,
  getNodeRect,
  onChange,
  history,
}) {
  let conns = []; // { id, from, to, label, line, labelEl }
  let selected = null;
  let connecting = false;
  let drag = null; // { from: {id, el}, ghost, target: {id, el}|null }

  const notify = () => onChange && onChange();
  const SVGNS = "http://www.w3.org/2000/svg";

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".conn-label") && !e.target.closest(".conn-line")) select(null);
  });

  function select(conn) {
    if (selected) {
      selected.line.classList.remove("selected");
      selected.labelEl.classList.remove("selected");
    }
    selected = conn;
    if (conn) {
      conn.line.classList.add("selected");
      conn.labelEl.classList.add("selected");
    }
  }

  function clear() {
    for (const c of conns) {
      c.line.remove();
      c.labelEl.remove();
    }
    conns = [];
    selected = null;
  }

  function load(list) {
    clear();
    (list || []).forEach(addConnEl);
    redraw();
  }

  function addConnEl(data) {
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("class", "conn-line");
    line.setAttribute("marker-end", "url(#arrowhead)");
    svg.appendChild(line);

    const labelEl = document.createElement("div");
    labelEl.className = "conn-label";
    labelEl.dataset.id = data.id;
    if (!data.label) labelEl.classList.add("empty");
    labelEl.textContent = data.label || "label";
    labelLayer.appendChild(labelEl);

    const conn = {
      id: data.id,
      from: data.from,
      to: data.to,
      label: data.label || "",
      line,
      labelEl,
    };
    conns.push(conn);

    const stop = (e) => e.stopPropagation();
    line.addEventListener("mousedown", (e) => {
      stop(e);
      select(conn);
    });
    labelEl.addEventListener("mousedown", stop);
    labelEl.addEventListener("click", (e) => {
      stop(e);
      select(conn);
    });
    // Rename on right-click, consistent with renaming a board.
    labelEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      stop(e);
      beginEditLabel(conn);
    });
    return conn;
  }

  /* ---- geometry: clip the center→center line to each node's border ---- */
  function center(r) {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  function borderPoint(rect, target) {
    const c = center(rect);
    const dx = target.x - c.x;
    const dy = target.y - c.y;
    if (!dx && !dy) return c;
    const tx = dx !== 0 ? rect.w / 2 / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? rect.h / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  // Reposition every arrow from current node geometry. Arrows whose endpoints
  // are missing (node deleted mid-frame) hide until cleaned up.
  function redraw() {
    for (const conn of conns) {
      const fromR = getNodeRect(conn.from);
      const toR = getNodeRect(conn.to);
      if (!fromR || !toR) {
        conn.line.style.display = "none";
        conn.labelEl.style.display = "none";
        continue;
      }
      conn.line.style.display = "";
      conn.labelEl.style.display = "";
      const a = borderPoint(fromR, center(toR));
      const b = borderPoint(toR, center(fromR));
      conn.line.setAttribute("x1", a.x);
      conn.line.setAttribute("y1", a.y);
      conn.line.setAttribute("x2", b.x);
      conn.line.setAttribute("y2", b.y);
      conn.labelEl.style.left = (a.x + b.x) / 2 + "px";
      conn.labelEl.style.top = (a.y + b.y) / 2 + "px";
    }
  }

  /* ---- label editing ---- */
  function beginEditLabel(conn) {
    const input = document.createElement("input");
    input.className = "conn-label-input";
    input.value = conn.label;
    // Sit the input exactly where the label is (its own translate(-50%,-50%)
    // centers it on the arrow midpoint).
    input.style.left = conn.labelEl.style.left;
    input.style.top = conn.labelEl.style.top;
    conn.labelEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const label = input.value.trim();
      conn.label = label;
      conn.labelEl.textContent = label || "label";
      conn.labelEl.classList.toggle("empty", !label);
      input.replaceWith(conn.labelEl);
      persist(conn, { label });
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") {
        input.value = conn.label;
        input.blur();
      }
    });
    input.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  async function persist(conn, patch) {
    const id = getBoardId();
    if (!id) return;
    try {
      await api.updateConnection(id, conn.id, patch);
    } catch (err) {
      console.error(err);
    }
  }

  /* ---- deletion ---- */
  function removeConn(conn) {
    conn.line.remove();
    conn.labelEl.remove();
    const i = conns.indexOf(conn);
    if (i !== -1) conns.splice(i, 1);
    if (selected === conn) selected = null;
  }

  function deleteConn(conn) {
    const boardId = getBoardId();
    const snapshot = { id: conn.id, from: conn.from, to: conn.to, label: conn.label };
    removeConn(conn);
    if (boardId) api.deleteConnection(boardId, conn.id).catch((err) => console.error(err));
    if (history) {
      history.push({
        label: "delete connection",
        undo: async () => {
          const bid = getBoardId();
          if (!bid) return;
          try {
            const restored = await api.createConnection(bid, snapshot);
            select(addConnEl(restored));
            redraw();
          } catch (err) {
            console.error(err);
          }
        },
      });
    }
    notify();
  }

  function deleteSelected() {
    if (!selected) return false;
    deleteConn(selected);
    return true;
  }

  // Remove every arrow touching a node (the node was just deleted). The server
  // also prunes these on its side; here we just keep the UI in sync.
  function removeForNode(nodeId) {
    for (const conn of conns.filter((c) => c.from === nodeId || c.to === nodeId)) {
      removeConn(conn);
    }
    notify();
  }

  /* ---- connect mode: drag from one node to another (radial menu) ---- */

  // Enter connect mode. Nodes are locked (see app.js) so a press starts an
  // arrow rather than moving the node.
  function beginConnect() {
    connecting = true;
    document.body.classList.add("connecting");
  }

  function endDrag() {
    if (drag) {
      if (drag.ghost) drag.ghost.remove();
      drag.from.el.classList.remove("conn-source");
      if (drag.target) drag.target.el.classList.remove("conn-target");
      drag = null;
    }
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
  }

  function cancelConnect() {
    connecting = false;
    endDrag();
    document.body.classList.remove("connecting");
  }

  // Called by the app when a node is pressed while in connect mode: begin
  // dragging a ghost arrow out of that node.
  function startDragFrom(node) {
    if (!connecting || drag) return;
    const ghost = document.createElementNS(SVGNS, "line");
    ghost.setAttribute("class", "conn-ghost");
    ghost.setAttribute("marker-end", "url(#arrowhead)");
    svg.appendChild(ghost);
    drag = { from: node, ghost, target: null };
    node.el.classList.add("conn-source");
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  }

  // The node element under the cursor, if any (the ghost/labels/sections are
  // all pointer-events:none, so this finds the real node beneath).
  function nodeElAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    return el ? el.closest(".node") : null;
  }

  function setTarget(el) {
    const next = el ? { id: el.dataset.id, el } : null;
    if ((drag.target && drag.target.el) === (next && next.el)) return;
    if (drag.target) drag.target.el.classList.remove("conn-target");
    drag.target = next;
    if (drag.target) drag.target.el.classList.add("conn-target");
  }

  function onDragMove(e) {
    if (!drag) return;
    const fromRect = getNodeRect(drag.from.id);
    if (!fromRect) return;

    let el = nodeElAt(e.clientX, e.clientY);
    if (el && el.dataset.id === drag.from.id) el = null; // ignore the source
    setTarget(el);

    let a, b;
    if (drag.target) {
      const tRect = getNodeRect(drag.target.id);
      a = borderPoint(fromRect, center(tRect));
      b = borderPoint(tRect, center(fromRect));
    } else {
      const r = canvas.getBoundingClientRect();
      const cursor = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      a = borderPoint(fromRect, cursor);
      b = cursor;
    }
    drag.ghost.setAttribute("x1", a.x);
    drag.ghost.setAttribute("y1", a.y);
    drag.ghost.setAttribute("x2", b.x);
    drag.ghost.setAttribute("y2", b.y);
  }

  async function onDragEnd() {
    if (!drag) return;
    const fromId = drag.from.id;
    const target = drag.target;
    endDrag();
    cancelConnect(); // one arrow per activation; exit the mode

    if (!target || target.id === fromId) return; // released on nothing / self
    const boardId = getBoardId();
    if (!boardId) return;
    try {
      const conn = await api.createConnection(boardId, {
        from: fromId,
        to: target.id,
        label: "",
      });
      const created = addConnEl(conn);
      redraw();
      select(created);
      beginEditLabel(created);
      notify();
    } catch (err) {
      console.error(err);
    }
  }

  return {
    load,
    clear,
    redraw,
    deleteSelected,
    removeForNode,
    beginConnect,
    cancelConnect,
    startDragFrom,
    isConnecting: () => connecting,
  };
}
