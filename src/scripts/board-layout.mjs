// Arrow-aware auto layout — a section-respecting force-directed arranger shared
// by the agent CLI (`arrange`) and the in-app auto-arrange button. Pure: no DOM,
// no network, so it runs unchanged in the browser and in Node.
//
// The board is a *nesting* of containers: the root holds top-level sections and
// loose notes; each section holds its child sections and the notes it owns. We
// lay out each container independently with a Fruchterman-Reingold pass (arrows
// pull connected bodies together, every body repels every other) followed by a
// rectangle-separation pass that guarantees no overlap. Sections are sized
// bottom-up to wrap their laid-out contents, then placed top-down — so notes
// always stay inside their section and the section grouping is preserved, while
// arrows still shape the arrangement within and between groups.
//
// Deterministic: it starts from the current positions and uses no randomness, so
// the same board always arranges the same way (clean git diffs) and re-running
// it is stable rather than jittery.

const PAD = 32; // breathing room inside a container, around its contents
const GAP = 28; // minimum gap enforced between any two bodies
const HEADER = 44; // space reserved under a section's label
const MIN_SEC_W = 240;
const MIN_SEC_H = 160;

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
const contains = (o, i) =>
  i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
const strictContains = (o, i) => contains(o, i) && area(o) > area(i);

// Bounding box (in top-left coords) of a set of center-positioned bodies.
function bboxOf(bodies) {
  if (!bodies.length) return { minX: 0, minY: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bodies) {
    minX = Math.min(minX, b.x - b.w / 2);
    minY = Math.min(minY, b.y - b.h / 2);
    maxX = Math.max(maxX, b.x + b.w / 2);
    maxY = Math.max(maxY, b.y + b.h / 2);
  }
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

// Push apart any overlapping rectangles (with a GAP margin) along their axis of
// least penetration. Converges quickly for the handful of bodies a board holds.
function separate(bodies) {
  const n = bodies.length;
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const A = bodies[i], B = bodies[j];
        const ox =
          (A.w + B.w) / 2 + GAP - Math.abs(A.x - B.x);
        const oy =
          (A.h + B.h) / 2 + GAP - Math.abs(A.y - B.y);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox < oy) {
            const push = ox / 2;
            if (A.x <= B.x) { A.x -= push; B.x += push; }
            else { A.x += push; B.x -= push; }
          } else {
            const push = oy / 2;
            if (A.y <= B.y) { A.y -= push; B.y += push; }
            else { A.y += push; B.y -= push; }
          }
        }
      }
    }
    if (!moved) break;
  }
}

// Damped spring-electrical layout on center-positioned bodies (a small d3-force-
// style simulation). Three forces, each scaled by a cooling `alpha`:
//   • repulsion  — every pair pushes apart with a ~1/d falloff (clamped at short
//                  range so coincident bodies can't be flung to infinity);
//   • springs    — each edge pulls its endpoints toward a rest length L;
//   • gravity    — every body is drawn to the group's centroid.
// Gravity is what the old Fruchterman-Reingold pass lacked: without it, anything
// weakly connected drifts outward forever (repulsion has no counter-force), which
// is why boards exploded to hundreds of thousands of pixels. With it, the layout
// settles at a radius ~sqrt(n) — compact and bounded for any node count.
// Velocities carry momentum but decay each tick, so the system converges instead
// of oscillating. Deterministic: positions start from the current layout and no
// randomness is used. A final separation pass guarantees zero overlap.
function layoutBodies(bodies, edges) {
  const n = bodies.length;
  if (n <= 1) return;

  // Nudge any exactly-coincident bodies apart deterministically so the unit
  // vectors below never divide by zero (e.g. a fresh board, all notes stacked).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (bodies[i].x === bodies[j].x && bodies[i].y === bodies[j].y) {
        bodies[j].x += (j + 1) * 0.13;
        bodies[j].y += (i + 1) * 0.17;
      }
    }
  }

  const idx = new Map(bodies.map((b, i) => [b.id, i]));
  const avg = bodies.reduce((a, b) => a + (b.w + b.h) / 2, 0) / n;
  const L = avg + GAP; // desired distance between neighbouring bodies
  const repK = 0.9 * L * L; // repulsion strength (balances springs near ~1.3·L)
  const springK = 0.5; // spring stiffness toward rest length L
  // Gravity scales with repK (both ∝ L²), so the equilibrium radius stays a small
  // multiple of L at any L — the layout is compact whether bodies are tiny notes
  // or large wrapped sections. 0.9 keeps boards tight while arrows still cluster
  // connected bodies noticeably closer than average.
  const gravK = 0.9; // pull toward centroid — sets overall compactness
  const velDecay = 0.6; // fraction of velocity retained each tick (friction)
  const minDist = 0.5 * L; // clamp short-range repulsion to avoid blow-ups
  const maxStep = L; // hard cap on per-tick movement (belt-and-braces)

  const iters = Math.min(700, 300 + n * 12);
  const alphaDecay = 1 - Math.pow(0.001, 1 / iters);
  let alpha = 1;

  const vx = new Array(n).fill(0);
  const vy = new Array(n).fill(0);

  for (let it = 0; it < iters; it++) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += bodies[i].x; cy += bodies[i].y; }
    cx /= n; cy /= n;

    // Repulsion (~1/d), clamped so very-close bodies push gently, not violently.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = bodies[i].x - bodies[j].x;
        let dy = bodies[i].y - bodies[j].y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const eff = dist < minDist ? minDist : dist;
        const f = (repK * alpha) / eff;
        const ux = dx / dist, uy = dy / dist;
        vx[i] += ux * f; vy[i] += uy * f;
        vx[j] -= ux * f; vy[j] -= uy * f;
      }
    }
    // Springs: pull edge endpoints toward rest length L (push apart if closer).
    for (const [a, b] of edges) {
      const i = idx.get(a), j = idx.get(b);
      if (i === undefined || j === undefined) continue;
      let dx = bodies[j].x - bodies[i].x;
      let dy = bodies[j].y - bodies[i].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const f = springK * (dist - L) * alpha;
      const ux = dx / dist, uy = dy / dist;
      vx[i] += ux * f; vy[i] += uy * f;
      vx[j] -= ux * f; vy[j] -= uy * f;
    }
    // Gravity toward the centroid keeps the whole group from drifting apart.
    for (let i = 0; i < n; i++) {
      vx[i] += (cx - bodies[i].x) * gravK * alpha;
      vy[i] += (cy - bodies[i].y) * gravK * alpha;
    }
    // Integrate with friction and a per-tick step cap.
    for (let i = 0; i < n; i++) {
      vx[i] *= velDecay; vy[i] *= velDecay;
      let sx = vx[i], sy = vy[i];
      const sp = Math.hypot(sx, sy);
      if (sp > maxStep) { sx = (sx / sp) * maxStep; sy = (sy / sp) * maxStep; }
      bodies[i].x += sx; bodies[i].y += sy;
    }
    alpha *= 1 - alphaDecay;
  }

  separate(bodies);
}

function postOrderSections(roots, childMap) {
  const out = [];
  const visit = (s) => {
    for (const c of childMap.get(s.id)) visit(c);
    out.push(s);
  };
  for (const r of roots) visit(r);
  return out;
}

// Arrange a board. `model` = { nodes, sections, connections } (as returned by the
// storage layer / export getters). Returns NEW geometry — { nodes:[{id,x,y,w,h}],
// sections:[{id,x,y,w,h}] } — without mutating the input; the caller persists the
// items whose geometry actually changed.
export function arrangeBoard(model) {
  const nodes = (model.nodes || []).map((n) => ({ ...n }));
  const sections = (model.sections || []).map((s) => ({ ...s }));
  const connections = model.connections || [];

  const sById = new Map(sections.map((s) => [s.id, s]));
  const nById = new Map(nodes.map((n) => [n.id, n]));

  // Immediate parent of each note (smallest containing section) and section
  // (smallest strictly-containing section), mirroring the storage containment rule.
  const parentOfNote = new Map();
  for (const n of nodes) {
    let best = null;
    for (const s of sections) if (contains(s, n) && (!best || area(s) < area(best))) best = s;
    parentOfNote.set(n.id, best ? best.id : null);
  }
  const parentOfSection = new Map();
  for (const s of sections) {
    let best = null;
    for (const o of sections)
      if (o.id !== s.id && strictContains(o, s) && (!best || area(o) < area(best))) best = o;
    parentOfSection.set(s.id, best ? best.id : null);
  }
  const parentOf = (id) => (nById.has(id) ? parentOfNote.get(id) : parentOfSection.get(id));

  const childSectionsOf = new Map(sections.map((s) => [s.id, []]));
  const rootSections = [];
  for (const s of sections) {
    const p = parentOfSection.get(s.id);
    if (p) childSectionsOf.get(p).push(s);
    else rootSections.push(s);
  }
  const ownedNotesOf = new Map(sections.map((s) => [s.id, []]));
  const rootNotes = [];
  for (const n of nodes) {
    const p = parentOfNote.get(n.id);
    if (p) ownedNotesOf.get(p).push(n);
    else rootNotes.push(n);
  }

  // The body in `idSet` that an arrow endpoint belongs to — itself, or the
  // ancestor section (at this container's level) that contains it. Lets a note→
  // note arrow across two sections pull those *sections* together at root level.
  function bodyInContainer(endpointId, idSet) {
    let cur = endpointId;
    while (cur != null && cur !== undefined) {
      if (idSet.has(cur)) return cur;
      cur = parentOf(cur);
    }
    return null;
  }
  function edgesFor(bodyList) {
    const idSet = new Set(bodyList.map((b) => b.id));
    const seen = new Set();
    const edges = [];
    for (const c of connections) {
      const a = bodyInContainer(c.from, idSet);
      const b = bodyInContainer(c.to, idSet);
      if (a && b && a !== b) {
        const key = a < b ? a + "|" + b : b + "|" + a;
        if (!seen.has(key)) { seen.add(key); edges.push([a, b]); }
      }
    }
    return edges;
  }

  // Phase A — size sections bottom-up so a parent sees its children's final size.
  const relLayout = new Map(); // sectionId -> { children:[{id,relX,relY}] }
  for (const s of postOrderSections(rootSections, childSectionsOf)) {
    const bodies = [
      ...childSectionsOf.get(s.id).map((cs) => ({ id: cs.id, w: cs.w, h: cs.h, x: cs.x + cs.w / 2, y: cs.y + cs.h / 2 })),
      ...ownedNotesOf.get(s.id).map((n) => ({ id: n.id, w: n.w, h: n.h, x: n.x + n.w / 2, y: n.y + n.h / 2 })),
    ];
    if (!bodies.length) {
      relLayout.set(s.id, { children: [] }); // empty section keeps its size
      continue;
    }
    layoutBodies(bodies, edgesFor(bodies));
    const bb = bboxOf(bodies);
    relLayout.set(s.id, {
      children: bodies.map((b) => ({
        id: b.id,
        relX: b.x - b.w / 2 - bb.minX,
        relY: b.y - b.h / 2 - bb.minY,
      })),
    });
    s.w = Math.max(MIN_SEC_W, Math.round(bb.w + 2 * PAD));
    s.h = Math.max(MIN_SEC_H, Math.round(bb.h + HEADER + 2 * PAD));
  }

  // Phase B — arrange the root container, then place every body top-down. Anchor
  // the result at the original top-left so the board doesn't jump across canvas.
  const rootBodies = [
    ...rootSections.map((s) => ({ id: s.id, w: s.w, h: s.h, x: s.x + s.w / 2, y: s.y + s.h / 2 })),
    ...rootNotes.map((n) => ({ id: n.id, w: n.w, h: n.h, x: n.x + n.w / 2, y: n.y + n.h / 2 })),
  ];
  const before = bboxOf(rootBodies);
  layoutBodies(rootBodies, edgesFor(rootBodies));
  const after = bboxOf(rootBodies);
  const ox = before.minX - after.minX;
  const oy = before.minY - after.minY;

  function place(bodyId, x, y) {
    if (sById.has(bodyId)) {
      const s = sById.get(bodyId);
      s.x = Math.round(x);
      s.y = Math.round(y);
      const rl = relLayout.get(s.id);
      const cx = s.x + PAD;
      const cy = s.y + HEADER + PAD;
      for (const ch of rl.children) place(ch.id, cx + ch.relX, cy + ch.relY);
    } else {
      const n = nById.get(bodyId);
      n.x = Math.round(x);
      n.y = Math.round(y);
    }
  }
  for (const b of rootBodies) place(b.id, b.x - b.w / 2 + ox, b.y - b.h / 2 + oy);

  return {
    nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
    sections: sections.map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h })),
  };
}
