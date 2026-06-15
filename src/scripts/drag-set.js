// A reusable "drag set": snapshot the starting positions of a set of rectangular
// items, apply a world-space (dx, dy) offset to all of them as a drag proceeds,
// then persist their final (rounded) positions when it ends. Used everywhere the
// app moves items as a unit — a marquee group, the nodes/sections a section
// contains, and cross-layer group drags driven from another layer.
//
//   place(item)          — reposition the item's element from its x/y
//   persist(item, {x,y}) — save the moved item
export function createDragSet({ place, persist }) {
  let origins = []; // [{ item, ox, oy }] snapshot taken at capture()

  return {
    // Snapshot each item's x/y so later offsets are relative to the drag start.
    capture(items) {
      origins = items.map((it) => ({ item: it, ox: it.x, oy: it.y }));
    },
    // Move every captured item by (dx, dy). Returns the count moved so the caller
    // can skip a redraw when the set is empty.
    apply(dx, dy) {
      origins.forEach((o) => {
        o.item.x = o.ox + dx;
        o.item.y = o.oy + dy;
        place(o.item);
      });
      return origins.length;
    },
    // Persist the final integer positions of the items that actually moved and
    // drop the snapshot. Returns one descriptor per moved item carrying a
    // self-contained restore() (used to build a single undo command for the whole
    // gesture, even when it spans several drag sets across layers).
    commit() {
      const moved = [];
      origins.forEach((o) => {
        const from = { x: Math.round(o.ox), y: Math.round(o.oy) };
        const to = { x: Math.round(o.item.x), y: Math.round(o.item.y) };
        if (from.x === to.x && from.y === to.y) return; // a click, not a drag
        persist(o.item, to);
        const item = o.item;
        moved.push({
          item,
          from,
          to,
          restore() {
            item.x = from.x;
            item.y = from.y;
            place(item);
            persist(item, from);
          },
        });
      });
      origins = [];
      return moved;
    },
    clear() {
      origins = [];
    },
    get size() {
      return origins.length;
    },
  };
}
