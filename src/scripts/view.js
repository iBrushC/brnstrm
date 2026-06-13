// Shared canvas view transform + coordinate helpers.
// The viewport element is translated/scaled by this transform; everything
// inside it (nodes) lives in "world" coordinates.

export const view = { x: 0, y: 0, scale: 1 };

// Canvas-relative screen point -> world coordinates.
export function screenToWorld(cx, cy) {
  return {
    x: (cx - view.x) / view.scale,
    y: (cy - view.y) / view.scale,
  };
}
