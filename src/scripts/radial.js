// Radial ("press-and-aim") menu for creating nodes.
//
// Flow: hold a key to open the menu at the cursor → move the mouse toward a
// quarter to aim → release to pick. Releasing in the center dead-zone (or at an
// empty quarter) cancels. Built to grow: pass one option per quarter and each
// lights up its wedge the same way; only the filled quarters are pickable.

const RADIUS = 92; // px — menu outer radius
const DEAD_ZONE = 26; // px — center radius that cancels on release

// Quarter centered on each compass position (screen angles, y-down, 0° = right).
const POS_ANGLE = { top: -90, right: 0, bottom: 90, left: 180 };

// Which quarter a cursor offset points at (regardless of distance).
function quarterAt(dx, dy) {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
  if (a >= -135 && a < -45) return "top";
  if (a >= -45 && a < 45) return "right";
  if (a >= 45 && a < 135) return "bottom";
  return "left";
}

// options: [{ id, label, position: 'top'|'right'|'bottom'|'left', onPick(point) }]
export function createRadialMenu({ container, options }) {
  const byPos = new Map(options.map((o) => [o.position, o]));

  const root = document.createElement("div");
  root.className = "radial";
  root.style.width = root.style.height = RADIUS * 2 + "px";

  const ring = document.createElement("div");
  ring.className = "radial-ring";

  const hub = document.createElement("div");
  hub.className = "radial-hub";
  hub.textContent = "+";

  root.append(ring, hub);

  // Place each option's label in the middle of its quarter.
  for (const o of options) {
    const el = document.createElement("div");
    el.className = "radial-opt";
    el.dataset.pos = o.position;
    el.textContent = o.label;
    const rad = (POS_ANGLE[o.position] * Math.PI) / 180;
    el.style.left = RADIUS + Math.cos(rad) * RADIUS * 0.6 + "px";
    el.style.top = RADIUS + Math.sin(rad) * RADIUS * 0.6 + "px";
    root.appendChild(el);
    o._el = el;
  }

  container.appendChild(root);

  let open = false;
  let cx = 0;
  let cy = 0; // menu center, container-relative
  let point = null; // payload captured at open (the world spawn point)
  let active = null; // option currently aimed at, or null

  function setActive(opt) {
    if (active === opt) return;
    if (active) active._el.classList.remove("active");
    active = opt;
    if (active) {
      active._el.classList.add("active");
      // Light the aimed wedge: screen angle -> conic angle (0° = up, clockwise).
      const c = POS_ANGLE[active.position] + 90;
      ring.style.background =
        `conic-gradient(from ${c - 45}deg, var(--radial-hi) 0deg 90deg, ` +
        `transparent 90deg 360deg), var(--panel)`;
      ring.classList.add("lit");
    } else {
      ring.style.background = "";
      ring.classList.remove("lit");
    }
  }

  // Open at a container-relative point, stashing an arbitrary payload (the world
  // point where the node should spawn — the press location, not the release).
  function show(screenX, screenY, payload) {
    open = true;
    cx = screenX;
    cy = screenY;
    point = payload;
    root.style.left = cx - RADIUS + "px";
    root.style.top = cy - RADIUS + "px";
    root.classList.add("visible");
    setActive(null);
  }

  function update(screenX, screenY) {
    if (!open) return;
    const dx = screenX - cx;
    const dy = screenY - cy;
    if (Math.hypot(dx, dy) < DEAD_ZONE) return setActive(null);
    setActive(byPos.get(quarterAt(dx, dy)) || null);
  }

  // Close and, if a quarter was aimed at, fire its action with the payload.
  function release() {
    if (!open) return;
    open = false;
    root.classList.remove("visible");
    const picked = active;
    setActive(null);
    if (picked) picked.onPick(point);
  }

  function cancel() {
    open = false;
    setActive(null);
    root.classList.remove("visible");
  }

  return { show, update, release, cancel, isOpen: () => open };
}
