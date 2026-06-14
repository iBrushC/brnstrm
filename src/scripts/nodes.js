// Node layer — kept separate from app/canvas because nodes will grow far more
// complex (multiple content types, resizing, connections, etc.). For now a node
// is a draggable, resizable box with a title bar and a plain textarea.

import { view } from "./view.js";
import { api } from "./api.js";

const DEFAULT_W = 220;
const DEFAULT_H = 140;
const MIN_W = 140;
const MIN_H = 80;

// Hooks beyond the basics:
//   onNodeClick(node) — fired when a node is pressed (lets arrows pick endpoints)
//   onDelete(nodeId)  — fired after a node is removed (lets arrows clean up)
//   isLocked()        — when true, drag/resize are suppressed (e.g. while the
//                       user is in "connect two nodes" mode and clicks should
//                       only pick, not move)
export function createNodeLayer({
  viewport,
  getBoardId,
  onChange,
  history,
  onNodeClick,
  onDelete,
  isLocked,
  onGroupDragStart,
  onGroupDragMove,
  onGroupDragEnd,
}) {
  let nodes = []; // { id, x, y, w, h, content, el, textarea }
  let selected = null;
  let groupSel = []; // nodes currently marquee-selected for group move
  let groupOrigins = []; // captured when another layer drives a group drag
  let containedOrigins = []; // captured when a section drag moves its contained nodes

  const locked = () => (typeof isLocked === "function" ? isLocked() : false);

  function clearGroupSel() {
    groupSel.forEach((n) => n.el.classList.remove("group-selected"));
    groupSel = [];
  }

  function select(node) {
    if (selected) selected.el.classList.remove("selected");
    selected = node;
    if (node) node.el.classList.add("selected");
    // Clear group unless we're clicking into a group member (to allow group drag).
    if (!node || !groupSel.includes(node)) clearGroupSel();
  }

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".node")) select(null);
  });

  function selectInRect(worldRect) {
    clearGroupSel();
    groupSel = nodes.filter((n) =>
      n.x < worldRect.x + worldRect.w &&
      n.x + n.w > worldRect.x &&
      n.y < worldRect.y + worldRect.h &&
      n.y + n.h > worldRect.y
    );
    groupSel.forEach((n) => n.el.classList.add("group-selected"));
  }

  function clear() {
    viewport.innerHTML = "";
    nodes = [];
    selected = null;
  }

  // Replace the current board's nodes with `list` (from the API). Undo history
  // is per-board, so switching boards starts a fresh stack.
  function load(list) {
    clear();
    if (history) history.clear();
    list.forEach(addNodeEl);
    onChange();
  }

  function addNodeEl(data) {
    const el = document.createElement("div");
    el.className = "node";
    el.dataset.id = data.id;
    el.style.left = data.x + "px";
    el.style.top = data.y + "px";
    el.style.width = (data.w || DEFAULT_W) + "px";
    el.style.height = (data.h || DEFAULT_H) + "px";

    const bar = document.createElement("div");
    bar.className = "node-bar";
    bar.textContent = data.name || data.id;
    bar.title = "drag to move · right-click to rename";

    const ta = document.createElement("textarea");
    ta.className = "node-text";
    ta.value = data.content || "";
    ta.spellcheck = false;
    ta.placeholder = "…";

    const handle = document.createElement("div");
    handle.className = "node-resize";
    handle.title = "Drag to resize";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "node-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Delete node";

    el.append(bar, ta, handle, deleteBtn);
    viewport.appendChild(el);

    const node = {
      id: data.id,
      name: data.name || "",
      x: data.x,
      y: data.y,
      w: data.w || DEFAULT_W,
      h: data.h || DEFAULT_H,
      content: data.content || "",
      el,
      bar,
      textarea: ta,
    };
    nodes.push(node);

    // Keep canvas pan/zoom from triggering when interacting with a node.
    el.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      // While locked (connect mode), the press only starts an arrow — don't
      // select or focus the textarea underneath.
      if (locked()) {
        e.preventDefault();
        if (onNodeClick) onNodeClick(node);
        return;
      }
      select(node);
      if (onNodeClick) onNodeClick(node);
    });
    bar.addEventListener("mousedown", (e) => startDrag(e, node));
    // Rename on right-click, consistent with renaming a board.
    bar.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      beginRename(node);
    });
    handle.addEventListener("mousedown", (e) => startResize(e, node));
    deleteBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteNode(node); });

    // Persist content edits (debounced).
    let timer;
    ta.addEventListener("input", () => {
      node.content = ta.value;
      clearTimeout(timer);
      timer = setTimeout(() => persist(node, { content: ta.value }), 400);
    });

    return node;
  }

  /* ---- renaming (title bar) ---- */
  // Swap the title bar for an inline input. The node id is shown as a
  // placeholder so an emptied name reverts the file to its id on disk.
  function beginRename(node, { onCommit } = {}) {
    const input = document.createElement("input");
    input.className = "node-name-input";
    input.value = node.name || "";
    input.placeholder = node.id;
    node.bar.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      node.name = name;
      node.bar.textContent = name || node.id;
      input.replaceWith(node.bar);
      rename(node, name);
      if (onCommit) onCommit();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") {
        input.value = node.name || "";
        input.blur();
      }
    });
    input.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  async function rename(node, name) {
    const id = getBoardId();
    if (!id) return;
    try {
      await api.renameNode(id, node.id, name);
    } catch (err) {
      console.error(err);
    }
  }

  /* ---- dragging ---- */
  let drag = null;

  function startDrag(e, node) {
    if (e.button !== 0) return;
    if (locked()) return;
    e.preventDefault();
    const inGroup = groupSel.includes(node);
    // If this node is part of a marquee group, drag the whole group.
    if (groupSel.length > 1 && inGroup) {
      drag = {
        group: groupSel.map((n) => ({ node: n, ox: n.x, oy: n.y })),
        sx: e.clientX,
        sy: e.clientY,
        crossLayer: true,
      };
    } else {
      drag = { node, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, crossLayer: inGroup };
    }
    if (inGroup && onGroupDragStart) onGroupDragStart();
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", endDrag);
  }

  function onDrag(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / view.scale;
    const dy = (e.clientY - drag.sy) / view.scale;
    if (drag.group) {
      drag.group.forEach((g) => {
        g.node.x = g.ox + dx;
        g.node.y = g.oy + dy;
        g.node.el.style.left = g.node.x + "px";
        g.node.el.style.top = g.node.y + "px";
      });
    } else {
      drag.node.x = drag.ox + dx;
      drag.node.y = drag.oy + dy;
      drag.node.el.style.left = drag.node.x + "px";
      drag.node.el.style.top = drag.node.y + "px";
    }
    if (drag.crossLayer && onGroupDragMove) onGroupDragMove(dx, dy);
    onChange();
  }

  function endDrag() {
    if (drag) {
      if (drag.group) {
        drag.group.forEach((g) => persist(g.node, { x: g.node.x, y: g.node.y }));
      } else {
        persist(drag.node, { x: drag.node.x, y: drag.node.y });
      }
      if (drag.crossLayer && onGroupDragEnd) onGroupDragEnd();
      drag = null;
    }
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", endDrag);
  }

  // Called by another layer when it starts driving a group drag.
  function captureGroupOrigins() {
    groupOrigins = groupSel.map((n) => ({ node: n, ox: n.x, oy: n.y }));
  }

  // Called by another layer on each move event during its group drag.
  function applyGroupOffset(dx, dy) {
    groupOrigins.forEach((g) => {
      g.node.x = g.ox + dx;
      g.node.y = g.oy + dy;
      g.node.el.style.left = g.node.x + "px";
      g.node.el.style.top = g.node.y + "px";
    });
    if (groupOrigins.length) onChange();
  }

  // Called by another layer when its group drag ends.
  function commitGroupMove() {
    groupOrigins.forEach((g) => persist(g.node, { x: g.node.x, y: g.node.y }));
    groupOrigins = [];
  }

  // Called when a single section starts moving — capture nodes fully inside it.
  function captureNodesInRect(rect) {
    containedOrigins = nodes
      .filter((n) => n.x >= rect.x && n.y >= rect.y && n.x + n.w <= rect.x + rect.w && n.y + n.h <= rect.y + rect.h)
      .map((n) => ({ node: n, ox: n.x, oy: n.y }));
  }

  function applyContainedOffset(dx, dy) {
    containedOrigins.forEach((g) => {
      g.node.x = g.ox + dx;
      g.node.y = g.oy + dy;
      g.node.el.style.left = g.node.x + "px";
      g.node.el.style.top = g.node.y + "px";
    });
    if (containedOrigins.length) onChange();
  }

  function commitContainedMove() {
    containedOrigins.forEach((g) => persist(g.node, { x: g.node.x, y: g.node.y }));
    containedOrigins = [];
  }

  /* ---- resizing (bottom-right handle) ---- */
  let resize = null;

  function startResize(e, node) {
    if (locked()) return;
    e.preventDefault();
    e.stopPropagation(); // don't also start a drag/select on the node body
    select(node);
    resize = { node, sx: e.clientX, sy: e.clientY, ow: node.w, oh: node.h };
    window.addEventListener("mousemove", onResize);
    window.addEventListener("mouseup", endResize);
  }

  function onResize(e) {
    if (!resize) return;
    const dw = (e.clientX - resize.sx) / view.scale;
    const dh = (e.clientY - resize.sy) / view.scale;
    resize.node.w = Math.max(MIN_W, resize.ow + dw);
    resize.node.h = Math.max(MIN_H, resize.oh + dh);
    resize.node.el.style.width = resize.node.w + "px";
    resize.node.el.style.height = resize.node.h + "px";
    onChange();
  }

  function endResize() {
    if (resize) {
      persist(resize.node, {
        w: Math.round(resize.node.w),
        h: Math.round(resize.node.h),
      });
      resize = null;
    }
    window.removeEventListener("mousemove", onResize);
    window.removeEventListener("mouseup", endResize);
  }

  async function persist(node, patch) {
    const id = getBoardId();
    if (!id) return;
    try {
      await api.updateNode(id, node.id, patch);
    } catch (err) {
      console.error(err);
    }
  }

  // Create a node with its top-left anchored at the given world point.
  async function spawnAtWorld(wx, wy) {
    const id = getBoardId();
    if (!id) return;
    try {
      const node = await api.createNode(id, { x: Math.round(wx), y: Math.round(wy) });
      const created = addNodeEl(node);
      select(created);
      beginRename(created, { onCommit: () => setTimeout(() => created.textarea.focus(), 0) });
      onChange();
    } catch (err) {
      console.error(err);
    }
  }

  /* ---- deletion (with undo) ---- */
  function removeNode(node) {
    node.el.remove();
    const i = nodes.indexOf(node);
    if (i !== -1) nodes.splice(i, 1);
    if (selected === node) selected = null;
    if (onDelete) onDelete(node.id);
  }

  function deleteNode(node) {
    const boardId = getBoardId();
    // Snapshot enough to fully recreate the node on undo (same id + content).
    const snapshot = {
      id: node.id,
      name: node.name,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      content: node.content,
    };
    removeNode(node);
    if (boardId) api.deleteNode(boardId, node.id).catch((err) => console.error(err));

    if (history) {
      history.push({
        label: "delete node",
        undo: async () => {
          const bid = getBoardId();
          if (!bid) return;
          try {
            const restored = await api.createNode(bid, snapshot);
            select(addNodeEl(restored));
            onChange();
          } catch (err) {
            console.error(err);
          }
        },
      });
    }
    onChange();
  }

  // Delete the selected node, if any. Returns whether something was deleted.
  function deleteSelected() {
    if (!selected) return false;
    deleteNode(selected);
    return true;
  }

  // Minimal geometry for the minimap / recenter.
  function getRects() {
    return nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  }

  // Live geometry of a single node by id (used by arrows to find endpoints).
  function getNodeRect(id) {
    const n = nodes.find((n) => n.id === id);
    return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null;
  }

  return { load, clear, spawnAtWorld, deleteSelected, getRects, getNodeRect, selectInRect, clearGroupSel, captureGroupOrigins, applyGroupOffset, commitGroupMove, captureNodesInRect, applyContainedOffset, commitContainedMove };
}
