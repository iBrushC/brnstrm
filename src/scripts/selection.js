// Shared single + marquee-group selection for a layer of rectangular items
// (nodes and sections behave identically here). Each item must expose
// { x, y, w, h, el }; the owning layer supplies how to reposition an item's
// element (place) and how to persist a moved item (persist).
//
// The owning layer keeps its own active-drag state machine — this only owns the
// selection state (the single `selected` item and the marquee `group`) and the
// cross-layer origin helpers used when another layer drags a shared group.

export function createSelection({ getItems, place, persist, onChange }) {
  let selected = null;
  let group = []; // items marquee-selected for a group move
  let origins = []; // [{ item, ox, oy }] captured when another layer drives a drag

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
    clearGroup();
    group = getItems().filter((it) =>
      it.x < rect.x + rect.w &&
      it.x + it.w > rect.x &&
      it.y < rect.y + rect.h &&
      it.y + it.h > rect.y
    );
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
    origins = [];
  }

  /* ---- cross-layer group drag: another layer drives the move ---- */

  // Capture starting positions when another layer begins driving a group drag.
  function captureOrigins() {
    origins = group.map((it) => ({ item: it, ox: it.x, oy: it.y }));
  }

  // Apply the driving layer's offset on each move event.
  function applyOffset(dx, dy) {
    origins.forEach((o) => {
      o.item.x = o.ox + dx;
      o.item.y = o.oy + dy;
      place(o.item);
    });
    if (origins.length) notify();
  }

  // Persist the moved items when the driving layer's drag ends.
  function commitMove() {
    origins.forEach((o) =>
      persist(o.item, { x: Math.round(o.item.x), y: Math.round(o.item.y) })
    );
    origins = [];
  }

  return {
    select,
    selectInRect,
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
