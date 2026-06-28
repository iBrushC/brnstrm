// Shared single + marquee-group selection for a layer of rectangular items
// (nodes and sections behave identically here). Each item must expose
// { x, y, w, h, el }; the owning layer supplies how to reposition an item's
// element (place) and how to persist a moved item (persist).
//
// The owning layer keeps its own active-drag state machine — this only owns the
// selection state (the single `selected` item and the marquee `group`) and the
// cross-layer origin helpers used when another layer drags a shared group.

import { createDragSet } from "./drag-set.js";

export function createSelection({ getItems, place, persist, onChange }) {
  let selected = null;
  let group = []; // items marquee-selected for a group move
  // Drives the group's positions when another layer is doing the dragging.
  const crossDrag = createDragSet({ place, persist });

  const notify = () => onChange && onChange();

  function clearGroup() {
    group.forEach((it) => it.el.classList.remove("group-selected"));
    group = [];
  }

  function select(item) {
    if (selected) selected.el.classList.remove("selected");
    selected = item;
    if (item) item.el.classList.add("selected");
    // Keep the group when selecting a member (enables group drag); else clear.
    if (!item || !group.includes(item)) clearGroup();
  }

  function selectInRect(rect) {
    // A marquee supersedes any single selection, so the two never linger together
    // (which would leave the single selection behind on a group delete).
    if (selected) {
      selected.el.classList.remove("selected");
      selected = null;
    }
    clearGroup();
    group = getItems().filter((it) =>
      it.x < rect.x + rect.w &&
      it.x + it.w > rect.x &&
      it.y < rect.y + rect.h &&
      it.y + it.h > rect.y
    );
    group.forEach((it) => it.el.classList.add("group-selected"));
  }

  // Select an explicit set of items as a marquee group (used after a paste, so
  // the freshly-created copies come in ready to drag as one).
  function setGroup(items) {
    if (selected) {
      selected.el.classList.remove("selected");
      selected = null;
    }
    clearGroup();
    group = items.slice();
    group.forEach((it) => it.el.classList.add("group-selected"));
  }

  function shiftSelect(item) {
    // Seed the group from the current single selection on first shift+click.
    if (group.length === 0 && selected) {
      selected.el.classList.remove("selected");
      selected.el.classList.add("group-selected");
      group.push(selected);
      selected = null;
    }
    const i = group.indexOf(item);
    if (i !== -1) {
      item.el.classList.remove("group-selected");
      group.splice(i, 1);
    } else {
      item.el.classList.add("group-selected");
      group.push(item);
    }
  }

  // Reset both selections (called on load/clear, when the elements are gone).
  function reset() {
    selected = null;
    group = [];
    crossDrag.clear();
  }

  /* ---- cross-layer group drag: another layer drives the move ---- */

  // Capture starting positions when another layer begins driving a group drag.
  function captureOrigins() {
    crossDrag.capture(group);
  }

  // Apply the driving layer's offset on each move event.
  function applyOffset(dx, dy) {
    if (crossDrag.apply(dx, dy)) notify();
  }

  // Persist the moved items when the driving layer's drag ends. Returns the
  // moved descriptors so the driving layer can fold them into one undo command.
  function commitMove() {
    return crossDrag.commit();
  }

  return {
    select,
    selectInRect,
    setGroup,
    shiftSelect,
    clearGroup,
    reset,
    captureOrigins,
    applyOffset,
    commitMove,
    getSelected: () => selected,
    setSelected: (v) => {
      selected = v;
    },
    getGroup: () => group,
    isInGroup: (item) => group.includes(item),
  };
}
