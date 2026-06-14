// Connection layer — straight arrows that link two things and carry a
// relationship label. One "Arrow" tool handles both flavors: when you press to
// start, what's under the cursor is resolved hierarchically — a node wins if one
// is there, otherwise the innermost (smallest) section containing the point. That
// first press fixes the arrow's `kind` ("node"|"section"); the target must then
// be the same kind (no node↔section arrows). Section arrows are drawn wider and
// fainter to suit the larger, lower-contrast section boxes. Node and section ids
// never collide, so both kinds live together in connections.json (see storage.js).
//
// Each connection draws an SVG <line> (with an arrowhead marker) plus an HTML
// label at the midpoint. Both live inside the (transformed) viewport, so they
// pan/zoom in world space alongside the nodes. redraw() recomputes endpoints
// from the live node/section rects, so arrows follow what they connect as it moves.

import { api } from "./api.js";
import { screenToWorld } from "./view.js";
import { inlineEdit } from "./inline-edit.js";

export function createConnectionLayer({
  svg,
  labelLayer,
  canvas,
  getBoardId,
  getNodeRect,
  getSectionRect,
  getSectionAt, // (worldX, worldY) -> { id, el } | null  (innermost section)
  onChange,
  history,
}) {
  let conns = []; // { id, from, to, kind, label, line, labelEl }
  let selected = null;
  let connecting = false; // unified connect mode (node or section)
  let drag = null; // { kind, from: {id, el}, ghost, target: {id, el}|null }

  // Resolve an endpoint's live world rect by the connection's kind.
  const rectFor = (kind, id) =>
    kind === "section" ? getSectionRect(id) : getNodeRect(id);

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
    const kind = data.kind === "section" ? "section" : "node";
    const line = document.createElementNS(SVGNS, "line");
    // Section arrows carry an extra class for their wider, fainter look.
    line.setAttribute(
      "class",
      kind === "section" ? "conn-line conn-line-section" : "conn-line"
    );
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
      kind,
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
      const fromR = rectFor(conn.kind, conn.from);
      const toR = rectFor(conn.kind, conn.to);
      if (!fromR || !toR) {
        conn.line.style.display = "none";
        conn.labelEl.style.display = "none";
        continue;
      }
      conn.line.style.display = "";
      conn.labelEl.style.display = "";

      let x1, y1, x2, y2, labelX, labelY;
      const pairConn = conns.find(
        (c) => c.kind === conn.kind && c.from === conn.to && c.to === conn.from
      );
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
    const snapshot = { id: conn.id, from: conn.from, to: conn.to, kind: conn.kind, label: conn.label };
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
    for (const conn of conns.filter(
      (c) => c.kind === "node" && (c.from === nodeId || c.to === nodeId)
    )) {
      removeConn(conn);
    }
    notify();
  }

  // Same, for a deleted section's arrows.
  function removeForSection(sectionId) {
    for (const conn of conns.filter(
      (c) => c.kind === "section" && (c.from === sectionId || c.to === sectionId)
    )) {
      removeConn(conn);
    }
    notify();
  }

  /* ---- connect mode: drag from one thing to another (radial menu) ---- */

  // Enter connect mode. Nodes are locked (see app.js) so a press on a node only
  // starts an arrow (routed here via startDragFrom). Presses that miss every node
  // are caught by onConnectDown below, which resolves them to the innermost
  // section. One capture-phase listener handles that, pre-empting the section's
  // own move/select handlers.
  function beginConnect() {
    if (connecting) return;
    connecting = true;
    document.body.classList.add("connecting");
    document.addEventListener("mousedown", onConnectDown, true);
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
    document.removeEventListener("mousedown", onConnectDown, true);
  }

  // A press while connecting. Hierarchy: a node wins if one is under the cursor —
  // and the node layer (locked) handles that press itself, so we bow out and let
  // the event reach it. Otherwise we resolve the innermost section by geometry
  // and start a section arrow. A press over neither exits the mode and lets the
  // click do its normal thing.
  function onConnectDown(e) {
    if (e.button !== 0) return;
    // Leave UI chrome alone — sections are hit-tested by world geometry, which is
    // blind to overlays, so a press on the HUD/help/sidebar must not start an arrow.
    if (!e.target.closest("#canvas")) return; // outside the canvas (e.g. sidebar)
    if (e.target.closest("#hud, #help-btn, #help-guide")) return;
    if (elAt(e.clientX, e.clientY, ".node")) return; // node wins — let nodes.js handle it
    const r = canvas.getBoundingClientRect();
    const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const hit = getSectionAt(w.x, w.y);
    e.preventDefault();
    e.stopPropagation(); // pre-empt section move/select, box-select, or pan
    if (!hit) {
      cancelConnect();
      return;
    }
    if (!drag) startDrag("section", hit);
  }

  // Begin dragging a ghost arrow out of `from` ({id, el}) of the given kind.
  function startDrag(kind, from) {
    const ghost = document.createElementNS(SVGNS, "line");
    ghost.setAttribute(
      "class",
      kind === "section" ? "conn-ghost conn-ghost-section" : "conn-ghost"
    );
    ghost.setAttribute("marker-end", "url(#arrowhead)");
    svg.appendChild(ghost);
    drag = { kind, from, ghost, target: null };
    from.el.classList.add("conn-source");
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  }

  // Called by the app when a (locked) node is pressed while connecting: start a
  // node arrow from it. Matches the "node wins" rule in onConnectDown.
  function startDragFrom(node) {
    if (!connecting || drag) return;
    startDrag("node", node);
  }

  // The node element under the cursor, if any (ghosts/labels are click-through,
  // so this finds the real node beneath). Sections resolve by geometry instead.
  function elAt(clientX, clientY, selector) {
    const el = document.elementFromPoint(clientX, clientY);
    return el ? el.closest(selector) : null;
  }

  // Resolve the prospective target ({id, el}|null) under the cursor, of the
  // drag's kind: a node by DOM hit-test, a section by world-space geometry.
  function targetAt(clientX, clientY, world) {
    if (drag.kind === "node") {
      const el = elAt(clientX, clientY, ".node");
      return el ? { id: el.dataset.id, el } : null;
    }
    return getSectionAt(world.x, world.y);
  }

  function setTarget(next) {
    if ((drag.target && drag.target.el) === (next && next.el)) return;
    if (drag.target) drag.target.el.classList.remove("conn-target");
    drag.target = next;
    if (drag.target) drag.target.el.classList.add("conn-target");
  }

  function onDragMove(e) {
    if (!drag) return;
    const fromRect = rectFor(drag.kind, drag.from.id);
    if (!fromRect) return;

    const r = canvas.getBoundingClientRect();
    const cursor = screenToWorld(e.clientX - r.left, e.clientY - r.top);

    let hit = targetAt(e.clientX, e.clientY, cursor);
    if (hit && hit.id === drag.from.id) hit = null; // ignore the source
    setTarget(hit);

    let a, b;
    if (drag.target) {
      const tRect = rectFor(drag.kind, drag.target.id);
      a = borderPoint(fromRect, center(tRect));
      b = borderPoint(tRect, center(fromRect));
    } else {
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
    const kind = drag.kind;
    const fromId = drag.from.id;
    const target = drag.target;
    endDrag();
    cancelConnect(); // one arrow per activation; exit the mode

    if (!target || target.id === fromId) return; // released on nothing / self
    // Skip if an identical arrow (same kind + direction) already exists.
    if (conns.some((c) => c.kind === kind && c.from === fromId && c.to === target.id)) return;
    const boardId = getBoardId();
    if (!boardId) return;
    try {
      const payload = { from: fromId, to: target.id, label: "" };
      if (kind === "section") payload.kind = "section";
      const conn = await api.createConnection(boardId, payload);
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
    removeForSection,
    beginConnect,
    cancelConnect,
    startDragFrom,
    isConnecting: () => connecting,
  };
}
