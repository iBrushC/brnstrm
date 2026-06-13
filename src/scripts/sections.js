// Section layer — large labelled regions that sit *behind* the nodes and group
// them. A section is created by picking "Section" from the radial menu and then
// dragging a rectangle from its top-left to its bottom-right on the canvas.
//
// Sections mirror into the filesystem as folders (see storage.js): any node
// fully inside a section's box has its file moved into that section's folder.
// The grouping is recomputed server-side whenever a section or node moves, so
// the layer here only has to persist geometry + label.

import { view, screenToWorld } from "./view.js";
import { api } from "./api.js";

const MIN_SIZE = 24; // world px — drags smaller than this are treated as a miss
const DEFAULT_LABEL = "section";

export function createSectionLayer({ layer, canvas, getBoardId, onChange, history }) {
  let sections = []; // { id, x, y, w, h, label, el, labelEl }
  let selected = null;
  let drawing = false;
  let drawState = null;

  const notify = () => onChange && onChange();

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".section")) select(null);
  });

  function select(section) {
    if (selected) selected.el.classList.remove("selected");
    selected = section;
    if (section) section.el.classList.add("selected");
  }

  function clear() {
    layer.innerHTML = "";
    sections = [];
    selected = null;
  }

  function load(list) {
    clear();
    (list || []).forEach(addSectionEl);
    notify();
  }

  function applyRect(el, r) {
    el.style.left = r.x + "px";
    el.style.top = r.y + "px";
    el.style.width = r.w + "px";
    el.style.height = r.h + "px";
  }

  function addSectionEl(data) {
    const el = document.createElement("div");
    el.className = "section";
    el.dataset.id = data.id;
    applyRect(el, data);

    const bar = document.createElement("div");
    bar.className = "section-bar";

    const labelEl = document.createElement("span");
    labelEl.className = "section-label";
    labelEl.textContent = data.label || DEFAULT_LABEL;

    const del = document.createElement("button");
    del.className = "section-delete";
    del.textContent = "×";
    del.title = "Delete section";

    const handle = document.createElement("div");
    handle.className = "section-resize";
    handle.title = "Drag to resize";

    bar.append(labelEl, del);
    el.append(bar, handle);
    layer.appendChild(el);

    const section = {
      id: data.id,
      x: data.x,
      y: data.y,
      w: data.w,
      h: data.h,
      label: data.label || DEFAULT_LABEL,
      el,
      labelEl,
    };
    sections.push(section);

    el.addEventListener("mousedown", (e) => {
      // Only the bar/handle interact; clicking the body selects but must not
      // block panning over the (large, mostly-empty) section area.
      if (e.target === bar || e.target === labelEl) {
        e.stopPropagation();
        select(section);
      }
    });
    bar.addEventListener("mousedown", (e) => startDrag(e, section));
    handle.addEventListener("mousedown", (e) => startResize(e, section));
    del.addEventListener("mousedown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSection(section);
    });
    // Rename on right-click, consistent with renaming a board.
    labelEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      beginEditLabel(section);
    });

    return section;
  }

  /* ---- label editing ---- */
  function beginEditLabel(section) {
    const input = document.createElement("input");
    input.className = "section-label-input";
    input.value = section.label;
    section.labelEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const label = input.value.trim() || section.label;
      section.label = label;
      section.labelEl.textContent = label;
      input.replaceWith(section.labelEl);
      persist(section, { label });
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") {
        input.value = section.label;
        input.blur();
      }
    });
    input.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  /* ---- dragging (move) ---- */
  let drag = null;
  function startDrag(e, section) {
    if (e.target.classList.contains("section-delete")) return;
    e.preventDefault();
    e.stopPropagation();
    select(section);
    drag = { section, sx: e.clientX, sy: e.clientY, ox: section.x, oy: section.y };
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", endDrag);
  }
  function onDrag(e) {
    if (!drag) return;
    drag.section.x = drag.ox + (e.clientX - drag.sx) / view.scale;
    drag.section.y = drag.oy + (e.clientY - drag.sy) / view.scale;
    applyRect(drag.section.el, drag.section);
    notify();
  }
  function endDrag() {
    if (drag) {
      persist(drag.section, {
        x: Math.round(drag.section.x),
        y: Math.round(drag.section.y),
      });
      drag = null;
    }
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", endDrag);
  }

  /* ---- resizing (bottom-right) ---- */
  let resize = null;
  function startResize(e, section) {
    e.preventDefault();
    e.stopPropagation();
    select(section);
    resize = { section, sx: e.clientX, sy: e.clientY, ow: section.w, oh: section.h };
    window.addEventListener("mousemove", onResize);
    window.addEventListener("mouseup", endResize);
  }
  function onResize(e) {
    if (!resize) return;
    resize.section.w = Math.max(MIN_SIZE, resize.ow + (e.clientX - resize.sx) / view.scale);
    resize.section.h = Math.max(MIN_SIZE, resize.oh + (e.clientY - resize.sy) / view.scale);
    applyRect(resize.section.el, resize.section);
    notify();
  }
  function endResize() {
    if (resize) {
      persist(resize.section, {
        w: Math.round(resize.section.w),
        h: Math.round(resize.section.h),
      });
      resize = null;
    }
    window.removeEventListener("mousemove", onResize);
    window.removeEventListener("mouseup", endResize);
  }

  async function persist(section, patch) {
    const id = getBoardId();
    if (!id) return;
    try {
      await api.updateSection(id, section.id, patch);
      // A move/resize may have re-folded nodes server-side; nothing to reload
      // visually, but keep the minimap fresh.
      notify();
    } catch (err) {
      console.error(err);
    }
  }

  /* ---- deletion (with undo) ---- */
  function removeSection(section) {
    section.el.remove();
    const i = sections.indexOf(section);
    if (i !== -1) sections.splice(i, 1);
    if (selected === section) selected = null;
  }

  function deleteSection(section) {
    const boardId = getBoardId();
    const snapshot = {
      id: section.id,
      x: section.x,
      y: section.y,
      w: section.w,
      h: section.h,
      label: section.label,
    };
    removeSection(section);
    if (boardId) api.deleteSection(boardId, section.id).catch((err) => console.error(err));

    if (history) {
      history.push({
        label: "delete section",
        undo: async () => {
          const bid = getBoardId();
          if (!bid) return;
          try {
            const restored = await api.createSection(bid, snapshot);
            select(addSectionEl(restored));
            notify();
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
    deleteSection(selected);
    return true;
  }

  /* ---- draw mode (triggered from the radial menu) ---- */

  // Enter draw mode: the next left-drag on the canvas lays out a section. We
  // listen in the *capture* phase so the drag pre-empts panning and any node
  // interaction underneath.
  function beginDraw() {
    if (drawing) return;
    drawing = true;
    canvas.classList.add("drawing-section");
    canvas.addEventListener("mousedown", onDrawStart, true);
  }

  function cancelDraw() {
    drawing = false;
    canvas.classList.remove("drawing-section");
    canvas.removeEventListener("mousedown", onDrawStart, true);
    if (drawState) {
      drawState.preview.remove();
      drawState = null;
      window.removeEventListener("mousemove", onDrawMove);
      window.removeEventListener("mouseup", onDrawEnd);
    }
  }

  function rectFromPoints(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  function onDrawStart(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    canvas.removeEventListener("mousedown", onDrawStart, true); // single-shot
    const r = canvas.getBoundingClientRect();
    const start = screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const preview = document.createElement("div");
    preview.className = "section section-preview";
    layer.appendChild(preview);
    applyRect(preview, { x: start.x, y: start.y, w: 0, h: 0 });
    drawState = { start, preview, rect: r };
    window.addEventListener("mousemove", onDrawMove);
    window.addEventListener("mouseup", onDrawEnd);
  }

  function onDrawMove(e) {
    if (!drawState) return;
    const cur = screenToWorld(e.clientX - drawState.rect.left, e.clientY - drawState.rect.top);
    applyRect(drawState.preview, rectFromPoints(drawState.start, cur));
  }

  async function onDrawEnd(e) {
    if (!drawState) return;
    window.removeEventListener("mousemove", onDrawMove);
    window.removeEventListener("mouseup", onDrawEnd);
    const cur = screenToWorld(e.clientX - drawState.rect.left, e.clientY - drawState.rect.top);
    const rc = rectFromPoints(drawState.start, cur);
    drawState.preview.remove();
    drawState = null;
    cancelDraw();

    if (rc.w < MIN_SIZE || rc.h < MIN_SIZE) return; // treat tiny drags as a miss
    const boardId = getBoardId();
    if (!boardId) return;
    try {
      const section = await api.createSection(boardId, {
        x: Math.round(rc.x),
        y: Math.round(rc.y),
        w: Math.round(rc.w),
        h: Math.round(rc.h),
        label: DEFAULT_LABEL,
      });
      const created = addSectionEl(section);
      select(created);
      beginEditLabel(created);
      notify();
    } catch (err) {
      console.error(err);
    }
  }

  function getRects() {
    return sections.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }));
  }

  return {
    load,
    clear,
    beginDraw,
    cancelDraw,
    deleteSelected,
    getRects,
    isDrawing: () => drawing,
  };
}
