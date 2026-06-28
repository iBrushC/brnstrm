// Node layer — kept separate from app/canvas because nodes will grow far more
// complex (multiple content types, resizing, connections, etc.). For now a node
// is a draggable, resizable box with a title bar and a markdown body editor.

import { view } from "./view.js";
import { api } from "./api.js";
import { inlineEdit } from "./inline-edit.js";
import { createSelection } from "./selection.js";
import { createDragSet } from "./drag-set.js";
import { createMarkdownEditor } from "./markdown-editor.js";

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
  onExport,
  isLocked,
  onGroupDragStart,
  onGroupDragMove,
  onGroupDragEnd,
}) {
  let nodes = []; // { id, x, y, w, h, content, el, editor }

  const locked = () => (typeof isLocked === "function" ? isLocked() : false);

  const place = (n) => {
    n.el.style.left = n.x + "px";
    n.el.style.top = n.y + "px";
  };
  const persistMove = (n, patch) => persist(n, patch);

  // Single + marquee-group selection (shared with the section layer).
  const sel = createSelection({
    getItems: () => nodes,
    place,
    persist: persistMove,
    onChange,
  });
  const select = sel.select;

  // Moves the actively-dragged node(s); and, separately, the nodes a section
  // contains while that section is dragged (driven from the section layer).
  const activeDrag = createDragSet({ place, persist: persistMove });
  const containedDrag = createDragSet({ place, persist: persistMove });

  // Fold a gesture's moved items (which may span several drag sets across both
  // layers — see drag-set commit()) into a single undo command.
  function recordMove(moved) {
    if (!history || !moved.length) return;
    history.push({
      label: moved.length === 1 ? "move node" : "move " + moved.length + " items",
      undo: () => {
        moved.forEach((m) => m.restore());
        onChange();
      },
    });
  }

  document.addEventListener("mousedown", (e) => {
    if (!e.shiftKey && !e.target.closest(".node")) select(null);
  });

  function clear() {
    viewport.innerHTML = "";
    nodes = [];
    sel.reset();
  }

  // Replace the current board's nodes with `list` (from the API). The undo stack
  // is reset by the board switch itself (see app.js), before any layer loads.
  function load(list) {
    clear();
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

    // The body is a live-preview markdown editor (see markdown-editor.js).
    // `node` is referenced by the editor's input callback, so it's forward
    // declared and assigned just below.
    let node;
    let persistTimer;
    const md = createMarkdownEditor({
      value: data.content || "",
      onInput: (value) => {
        node.content = value;
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => persist(node, { content: value }), 400);
      },
      // "@" picker source + image/chip URL resolver, both scoped to the board.
      getResources: () => {
        const id = getBoardId();
        return id ? api.listResources(id) : Promise.resolve([]);
      },
      resolveResourceUrl: (name) => {
        const id = getBoardId();
        return id ? api.resourceUrl(id, name) : name;
      },
    });

    const handle = document.createElement("div");
    handle.className = "node-resize";
    handle.title = "Drag to resize";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "node-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Delete node";

    // Export button — floats just outside the top-right corner on hover and
    // copies this note as an LLM-ready prompt (see llm-export.js).
    const exportBtn = document.createElement("button");
    exportBtn.className = "node-export";
    exportBtn.textContent = "⧉ to agent";
    exportBtn.title = "Copy this note as an LLM prompt";

    el.append(bar, md.toolbar, md.editor, handle, deleteBtn, exportBtn);
    viewport.appendChild(el);

    node = {
      id: data.id,
      name: data.name || "",
      x: data.x,
      y: data.y,
      w: data.w || DEFAULT_W,
      h: data.h || DEFAULT_H,
      content: data.content || "",
      el,
      bar,
      editor: md,
    };
    nodes.push(node);

    // Keep canvas pan/zoom from triggering when interacting with a node.
    el.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      // While locked (connect mode), the press only starts an arrow — don't
      // select or focus the body editor underneath.
      if (locked()) {
        e.preventDefault();
        if (onNodeClick) onNodeClick(node);
        return;
      }
      if (e.shiftKey) {
        sel.shiftSelect(node);
      } else {
        select(node);
        if (onNodeClick) onNodeClick(node);
      }
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
    exportBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    exportBtn.addEventListener("click", (e) => { e.stopPropagation(); if (onExport) onExport(node); });

    return node;
  }

  /* ---- renaming (title bar) ---- */
  // Swap the title bar for an inline input. The node id is shown as a
  // placeholder so an emptied name reverts the file to its id on disk.
  function beginRename(node, { onCommit } = {}) {
    inlineEdit(node.bar, {
      className: "node-name-input",
      value: node.name || "",
      placeholder: node.id,
      onCommit: (name, input) => {
        node.name = name;
        node.bar.textContent = name || node.id;
        input.replaceWith(node.bar);
        rename(node, name);
        if (onCommit) onCommit();
      },
    });
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
    const group = sel.getGroup();
    const inGroup = sel.isInGroup(node);
    // If this node is part of a marquee group, drag the whole group.
    activeDrag.capture(group.length > 1 && inGroup ? group : [node]);
    drag = { sx: e.clientX, sy: e.clientY, crossLayer: inGroup };
    if (inGroup && onGroupDragStart) onGroupDragStart();
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", endDrag);
  }

  function onDrag(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / view.scale;
    const dy = (e.clientY - drag.sy) / view.scale;
    activeDrag.apply(dx, dy);
    if (drag.crossLayer && onGroupDragMove) onGroupDragMove(dx, dy);
    onChange();
  }

  function endDrag() {
    if (drag) {
      const moved = activeDrag.commit();
      if (drag.crossLayer && onGroupDragEnd) {
        const more = onGroupDragEnd(); // sections moved with this group
        if (Array.isArray(more)) moved.push(...more);
      }
      recordMove(moved);
      drag = null;
    }
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", endDrag);
  }

  // Called when a single section starts moving — capture nodes fully inside it.
  function captureNodesInRect(rect) {
    containedDrag.capture(
      nodes.filter(
        (n) =>
          n.x >= rect.x &&
          n.y >= rect.y &&
          n.x + n.w <= rect.x + rect.w &&
          n.y + n.h <= rect.y + rect.h
      )
    );
  }

  function applyContainedOffset(dx, dy) {
    if (containedDrag.apply(dx, dy)) onChange();
  }

  // Returns the moved descriptors so the driving section layer can fold the
  // contained nodes into its single move-undo command.
  function commitContainedMove() {
    return containedDrag.commit();
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
      const node = resize.node;
      const from = { w: Math.round(resize.ow), h: Math.round(resize.oh) };
      const to = { w: Math.round(node.w), h: Math.round(node.h) };
      persist(node, to);
      if (history && (from.w !== to.w || from.h !== to.h)) {
        history.push({
          label: "resize node",
          undo: () => {
            node.w = from.w;
            node.h = from.h;
            node.el.style.width = from.w + "px";
            node.el.style.height = from.h + "px";
            persist(node, from);
            onChange();
          },
        });
      }
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
      beginRename(created, { onCommit: () => setTimeout(() => created.editor.focus(), 0) });
      onChange();
    } catch (err) {
      console.error(err);
    }
  }

  // Create a node at a world point with preset content/size (no rename prompt).
  // Used for file drops, which seed the body with a "@[file]" reference.
  async function createNodeAt(wx, wy, { content = "", name = "", w, h } = {}) {
    const id = getBoardId();
    if (!id) return null;
    try {
      const node = await api.createNode(id, {
        x: Math.round(wx),
        y: Math.round(wy),
        content,
        name,
        ...(w ? { w } : {}),
        ...(h ? { h } : {}),
      });
      const created = addNodeEl(node);
      select(created);
      onChange();
      return created;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  /* ---- deletion (with undo) ---- */
  function removeNode(node) {
    node.el.remove();
    const i = nodes.indexOf(node);
    if (i !== -1) nodes.splice(i, 1);
    if (sel.getSelected() === node) sel.setSelected(null);
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

  // Delete a whole set of nodes as one undoable action — used for marquee-group
  // deletion so a single Ctrl+Z brings the lot back, selected as a group again.
  function deleteNodes(list) {
    const boardId = getBoardId();
    const snapshots = list.map((node) => ({
      id: node.id,
      name: node.name,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      content: node.content,
    }));
    for (const node of list) {
      removeNode(node);
      if (boardId) api.deleteNode(boardId, node.id).catch((err) => console.error(err));
    }

    if (history) {
      history.push({
        label: list.length === 1 ? "delete node" : "delete " + list.length + " notes",
        undo: async () => {
          const bid = getBoardId();
          if (!bid) return;
          const restored = [];
          for (const snap of snapshots) {
            try {
              restored.push(addNodeEl(await api.createNode(bid, snap)));
            } catch (err) {
              console.error(err);
            }
          }
          if (restored.length === 1) select(restored[0]);
          else if (restored.length > 1) sel.setGroup(restored);
          onChange();
        },
      });
    }
    onChange();
  }

  // Delete the current selection. Prefers the marquee group if there is one,
  // else the single selection. Returns whether anything was deleted.
  function deleteSelected() {
    const group = sel.getGroup();
    if (group.length) {
      deleteNodes(group.slice());
      sel.clearGroup();
      return true;
    }
    const selected = sel.getSelected();
    if (!selected) return false;
    deleteNode(selected);
    return true;
  }

  /* ---- copy / paste ---- */
  // Snapshot the currently-selected note(s) — the marquee group if there is one,
  // otherwise the single selection — as plain data the caller can stash on a
  // clipboard. Returns [] when nothing is selected.
  function copySelected() {
    const group = sel.getGroup();
    const chosen = group.length ? group : sel.getSelected() ? [sel.getSelected()] : [];
    return chosen.map((n) => ({
      name: n.name,
      content: n.content,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
    }));
  }

  // Recreate clipboard items, anchoring their top-left bounding corner at the
  // given world point and preserving their relative layout. The new copies come
  // in selected so they can be dragged straight away.
  async function pasteAt(items, wx, wy) {
    if (!items || !items.length) return;
    const minX = Math.min(...items.map((i) => i.x));
    const minY = Math.min(...items.map((i) => i.y));
    const created = [];
    for (const it of items) {
      const node = await createNodeAt(wx + (it.x - minX), wy + (it.y - minY), {
        content: it.content,
        name: it.name,
        w: it.w,
        h: it.h,
      });
      if (node) created.push(node);
    }
    if (created.length === 1) select(created[0]);
    else if (created.length > 1) sel.setGroup(created);

    // Undo a paste by removing exactly the notes it created.
    if (history && created.length) {
      history.push({
        label: created.length === 1 ? "paste note" : "paste " + created.length + " notes",
        undo: async () => {
          const bid = getBoardId();
          for (const n of created) {
            removeNode(n);
            if (bid) {
              try {
                await api.deleteNode(bid, n.id);
              } catch (err) {
                console.error(err);
              }
            }
          }
          onChange();
        },
      });
    }
    onChange();
  }

  // Minimal geometry for the minimap / recenter.
  function getRects() {
    return nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  }

  // Full node data for the LLM exporter (geometry + name + raw content).
  function getExportNodes() {
    return nodes.map((n) => ({
      id: n.id,
      name: n.name,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      content: n.content,
    }));
  }

  // Live geometry of a single node by id (used by arrows to find endpoints).
  function getNodeRect(id) {
    const n = nodes.find((n) => n.id === id);
    return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null;
  }

  // The DOM element for a node by id (used by the comment layer to anchor a
  // comment badge inside the node so it tracks the node as it moves/zooms).
  function getNodeEl(id) {
    const n = nodes.find((n) => n.id === id);
    return n ? n.el : null;
  }

  return {
    load,
    clear,
    spawnAtWorld,
    createNodeAt,
    deleteSelected,
    copySelected,
    pasteAt,
    getRects,
    getExportNodes,
    getNodeRect,
    getNodeEl,
    selectInRect: sel.selectInRect,
    clearGroupSel: sel.clearGroup,
    captureGroupOrigins: sel.captureOrigins,
    applyGroupOffset: sel.applyOffset,
    commitGroupMove: sel.commitMove,
    captureNodesInRect,
    applyContainedOffset,
    commitContainedMove,
  };
}
