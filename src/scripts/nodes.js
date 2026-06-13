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
}) {
  let nodes = []; // { id, x, y, w, h, content, el, textarea }
  let selected = null;

  const locked = () => (typeof isLocked === "function" ? isLocked() : false);

  function select(node) {
    if (selected) selected.el.classList.remove("selected");
    selected = node;
    if (node) node.el.classList.add("selected");
  }

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".node")) select(null);
  });

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
  function beginRename(node) {
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
    if (e.button !== 0) return; // ignore right-click (rename) and middle-click
    if (locked()) return; // e.g. picking endpoints in connect mode
    e.preventDefault();
    drag = { node, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", endDrag);
  }

  function onDrag(e) {
    if (!drag) return;
    // Screen delta -> world delta (account for zoom).
    drag.node.x = drag.ox + (e.clientX - drag.sx) / view.scale;
    drag.node.y = drag.oy + (e.clientY - drag.sy) / view.scale;
    drag.node.el.style.left = drag.node.x + "px";
    drag.node.el.style.top = drag.node.y + "px";
    onChange();
  }

  function endDrag() {
    if (drag) {
      persist(drag.node, { x: drag.node.x, y: drag.node.y });
      drag = null;
    }
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", endDrag);
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
      created.textarea.focus();
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

  return { load, clear, spawnAtWorld, deleteSelected, getRects, getNodeRect };
}
