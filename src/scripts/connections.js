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
import { inlineEdit } from "./inline-edit.js";

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

  // Find where the ray from `origin` toward `target` first exits `rect`'s border.
  // Used to compute the start/end of offset parallel arrows that still connect
  // to the actual node edges rather than floating in mid-air next to them.
  function offsetBorderPoint(rect, origin, target) {
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    if (!dx && !dy) return center(rect);
    const EPS = 1e-6;
    let tMin = Infinity;
    if (Math.abs(dx) > EPS) {
      for (const wallX of [rect.x, rect.x + rect.w]) {
        const t = (wallX - origin.x) / dx;
        if (t > EPS) {
          const y = origin.y + t * dy;
          if (y >= rect.y - EPS && y <= rect.y + rect.h + EPS) tMin = Math.min(tMin, t);
        }
      }
    }
    if (Math.abs(dy) > EPS) {
      for (const wallY of [rect.y, rect.y + rect.h]) {
        const t = (wallY - origin.y) / dy;
        if (t > EPS) {
          const x = origin.x + t * dx;
          if (x >= rect.x - EPS && x <= rect.x + rect.w + EPS) tMin = Math.min(tMin, t);
        }
      }
    }
    if (tMin === Infinity) return center(rect);
    return { x: origin.x + tMin * dx, y: origin.y + tMin * dy };
  }

  // Reposition every arrow from current node geometry. Arrows whose endpoints
  // are missing (node deleted mid-frame) hide until cleaned up.
  const PAIR_OFFSET = 32;       // px world-space perpendicular offset for bidirectional pairs
  const LABEL_PAIR_OFFSET = 16; // px label offset along connection direction for nearly-vertical pairs

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

      let x1, y1, x2, y2, labelX, labelY;
      const pairConn = conns.find(c => c.from === conn.to && c.to === conn.from);
      if (pairConn) {
        // Shift the center-to-center axis perpendicular by PAIR_OFFSET, then
        // find where that offset axis intersects each node border. This keeps
        // both endpoints on the actual box edges regardless of angle.
        const fromC = center(fromR);
        const toC = center(toR);
        const cdx = toC.x - fromC.x;
        const cdy = toC.y - fromC.y;
        const clen = Math.sqrt(cdx * cdx + cdy * cdy) || 1;
        const ux = cdx / clen;
        const uy = cdy / clen;
        const perpX = -uy * PAIR_OFFSET;
        const perpY =  ux * PAIR_OFFSET;
        const fromCOff = { x: fromC.x + perpX, y: fromC.y + perpY };
        const toCOff   = { x: toC.x   + perpX, y: toC.y   + perpY };
        const pa = offsetBorderPoint(fromR, fromCOff, toCOff);
        const pb = offsetBorderPoint(toR, toCOff, fromCOff);
        x1 = pa.x; y1 = pa.y;
        x2 = pb.x; y2 = pb.y;

        labelX = (x1 + x2) / 2;
        labelY = (y1 + y2) / 2;

        // When nodes are nearly vertically aligned both labels share nearly the
        // same x midpoint and can overlap. Offset them along the connection
        // direction (parallel) so one sits above and the other below center.
        if (Math.abs(uy) > Math.abs(ux)) {
          labelX += ux * LABEL_PAIR_OFFSET;
          labelY += uy * LABEL_PAIR_OFFSET;
        }
      } else {
        const a = borderPoint(fromR, center(toR));
        const b = borderPoint(toR, center(fromR));
        x1 = a.x; y1 = a.y;
        x2 = b.x; y2 = b.y;
        labelX = (x1 + x2) / 2;
        labelY = (y1 + y2) / 2;
      }

      conn.line.setAttribute("x1", x1);
      conn.line.setAttribute("y1", y1);
      conn.line.setAttribute("x2", x2);
      conn.line.setAttribute("y2", y2);
      conn.labelEl.style.left = labelX + "px";
      conn.labelEl.style.top  = labelY + "px";
    }
  }

  /* ---- label editing ---- */
  function beginEditLabel(conn) {
    inlineEdit(conn.labelEl, {
      className: "conn-label-input",
      value: conn.label,
      // Sit the input exactly where the label is (its own translate(-50%,-50%)
      // centers it on the arrow midpoint).
      style: { left: conn.labelEl.style.left, top: conn.labelEl.style.top },
      onCommit: (label, input) => {
        conn.label = label;
        conn.labelEl.textContent = label || "label";
        conn.labelEl.classList.toggle("empty", !label);
        input.replaceWith(conn.labelEl);
        persist(conn, { label });
      },
    });
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
    if (conns.some(c => c.from === fromId && c.to === target.id)) return; // already exists
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
