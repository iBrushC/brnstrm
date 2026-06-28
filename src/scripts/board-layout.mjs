// Arrow-aware auto layout — a section-respecting arranger shared by the agent CLI
// (`arrange`) and the in-app auto-arrange button. Pure: no DOM, no network, so it
// runs unchanged in the browser and in Node.
//
// The board is a *nesting* of containers: the root holds top-level sections and
// loose notes; each section holds its child sections and the notes it owns. We
// lay out each container independently, then size sections bottom-up to wrap
// their laid-out contents and place them top-down — so notes always stay inside
// their section and the grouping is preserved.
//
// Within a container the goal is to approximate how a person arranges things, so
// we use a *hybrid* strategy (layoutBodies):
//   1. Split the bodies into connected components (following arrows, ignoring
//      direction). Disconnected components never need to interleave.
//   2. Bodies with no arrows at all are "loose" and get packed into a tidy grid
//      (6 loose notes → a near-square 3×2 grid, not a random scatter).
//   3. A component whose arrows form a DAG is drawn as a *layered* top-to-bottom
//      tree: a directed arrow A→B places A above B, children are centered under
//      their parents, and a barycenter pass orders each layer to reduce crossings.
//      This is what makes "1 node branching to 3" read as a neat fan-out.
//   4. A component that is cyclic or unusually dense falls back to the original
//      force-directed solver (forceLayout) — organic, but the only thing that
//      copes with tangled graphs. Its startup jitter is seeded deterministically
//      so repeated arranges of the same board are stable.
//   5. The per-component blocks and the loose grid are themselves packed into a
//      grid of blocks, then a rectangle-separation pass guarantees zero overlap.
//
// The layered + grid paths are fully deterministic, so "consistent alignment" and
// "consistent layouts even with constraints" hold: the same board arranges the
// same way every time, and unconstrained nodes align rather than scatter.

// Sizing base for auto-sized notes — mirrors the CLI `add-note` defaults, which
// is the "current width and height" auto-sizing scales up from.
export const BASE_NOTE_W = 280;
export const BASE_NOTE_H = 160;

// Derive a readable note size from its text, used by the CLI auto layout so the
// boards agents build don't cram a wall of text into a default box. Two
// independent signals grow the box from the base size:
//   • characters — every 250-char span beyond the first 250 (250–500, 500–750…)
//     adds half the base height; every 500-char span beyond the first 500 adds
//     half the base width. So 550 chars → 1.5× width, 2× height.
//   • newlines — each newline adds a fifth of the base height (additive on top
//     of the character-derived height).
// The size is a pure function of the content, so re-running arrange is
// idempotent — it never compounds the previous run's growth.
export function autoSizeNote(content, baseW = BASE_NOTE_W, baseH = BASE_NOTE_H) {
  const text = content || "";
  const chars = text.length;
  const newlines = (text.match(/\n/g) || []).length;

  // "beyond the first N" → a span only counts once the content spills into it,
  // so ceil(chars / span) - 1 spans have been entered past the base span.
  const heightSpans = Math.max(0, Math.ceil(chars / 250) - 1);
  const widthSpans = Math.max(0, Math.ceil(chars / 500) - 1);

  const w = baseW * (1 + 0.5 * widthSpans);
  const h = baseH * (1 + 0.5 * heightSpans) + baseH * 0.2 * newlines;
  return { w: Math.round(w), h: Math.round(h) };
}

const PAD = 32; // breathing room inside a container, around its contents
const GAP = 28; // minimum gap enforced between any two bodies
const HEADER = 44; // space reserved under a section's label
const MIN_SEC_W = 240;
const MIN_SEC_H = 160;

// Hybrid-layout spacing.
const HGAP = 36; // horizontal gap between siblings within a layer
const VGAP = 72; // vertical gap between layers (generous so arrows read top→down)
const GRID_GAP = GAP; // gap between loose nodes packed into a grid
const BLOCK_GAP = 56; // gap between independent components / the loose grid

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

// Deterministic [0,1) hash — stands in for Math.random() so the force fallback's
// startup jitter is stable across runs (the same board arranges the same way).
function hash01(k) {
  const s = Math.sin(k * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// Split a set of center-positioned bodies into connected components, following
// `edges` (directed [from,to] id pairs) but ignoring direction for connectivity.
// Returns { comps: [{nodes, edges}], loose } where each comp's `edges` are
// directed pairs of *local* indices into that comp's `nodes`, and `loose` is the
// bodies that have no arrows at all (singleton components with no edges).
function components(bodies, edges) {
  const n = bodies.length;
  const idx = new Map(bodies.map((b, i) => [b.id, i]));
  const de = edges
    .map(([a, b]) => [idx.get(a), idx.get(b)])
    .filter(([i, j]) => i !== undefined && j !== undefined && i !== j);

  const adj = Array.from({ length: n }, () => new Set());
  for (const [i, j] of de) { adj[i].add(j); adj[j].add(i); }

  const comp = new Array(n).fill(-1);
  let nc = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const stack = [s];
    comp[s] = nc;
    while (stack.length) {
      const u = stack.pop();
      for (const v of adj[u]) if (comp[v] === -1) { comp[v] = nc; stack.push(v); }
    }
    nc++;
  }

  const members = Array.from({ length: nc }, () => []);
  for (let i = 0; i < n; i++) members[comp[i]].push(i);
  const edgesByComp = Array.from({ length: nc }, () => []);
  for (const [i, j] of de) edgesByComp[comp[i]].push([i, j]);

  const comps = [];
  const loose = [];
  for (let c = 0; c < nc; c++) {
    const g = members[c];
    if (g.length === 1 && adj[g[0]].size === 0) { loose.push(bodies[g[0]]); continue; }
    const local = new Map(g.map((gi, k) => [gi, k]));
    comps.push({
      nodes: g.map((gi) => bodies[gi]),
      edges: edgesByComp[c].map(([i, j]) => [local.get(i), local.get(j)]),
    });
  }
  return { comps, loose };
}

// Layered top-to-bottom layout for a component whose arrows form a DAG. Mutates
// each node's center (x, y). A directed arrow A→B puts A in an earlier (higher)
// layer than B; siblings are barycenter-ordered to cut crossings and centered
// under their parents. Returns false (without moving anything) if the arrows
// contain a cycle, so the caller can fall back to the force solver.
function layeredLayout(nodes, edges) {
  const n = nodes.length;
  const out = Array.from({ length: n }, () => []);
  const inc = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) { out[u].push(v); inc[v].push(u); }

  // Longest-path layering via Kahn's algorithm; bails (returns false) on a cycle.
  const layer = new Array(n).fill(0);
  const indeg = inc.map((a) => a.length);
  const queue = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  let processed = 0;
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    processed++;
    for (const v of out[u]) {
      if (layer[u] + 1 > layer[v]) layer[v] = layer[u] + 1;
      if (--indeg[v] === 0) queue.push(v);
    }
  }
  if (processed < n) return false; // cycle → force fallback

  const maxL = Math.max(...layer);
  const layers = Array.from({ length: maxL + 1 }, () => []);
  for (let i = 0; i < n; i++) layers[layer[i]].push(i);

  // Crossing reduction: alternate down/up barycenter sweeps, reordering each
  // layer by the average position of its neighbors in the adjacent layer.
  const posInLayer = new Array(n);
  const reindex = () => { for (const lay of layers) lay.forEach((id, k) => { posInLayer[id] = k; }); };
  reindex();
  const sortByBary = (lay, neigh) => {
    const bary = new Map();
    for (const id of lay) {
      const ns = neigh[id];
      bary.set(id, ns.length ? ns.reduce((a, p) => a + posInLayer[p], 0) / ns.length : posInLayer[id]);
    }
    lay.sort((a, b) => bary.get(a) - bary.get(b));
    lay.forEach((id, k) => { posInLayer[id] = k; });
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let l = 1; l <= maxL; l++) sortByBary(layers[l], inc);
    for (let l = maxL - 1; l >= 0; l--) sortByBary(layers[l], out);
  }

  // Vertical: stack layers top→down, each row as tall as its tallest node.
  let y = 0;
  for (let l = 0; l <= maxL; l++) {
    const rowH = Math.max(...layers[l].map((id) => nodes[id].h));
    const cy = y + rowH / 2;
    for (const id of layers[l]) nodes[id].y = cy;
    y += rowH + VGAP;
  }

  // Horizontal: seed left→right, then iteratively pull each node toward the mean
  // x of its neighbors while keeping order + min gap. Centering the whole layer on
  // the neighbors' mean keeps children fanned out symmetrically under a parent.
  for (const lay of layers) {
    let x = 0;
    for (const id of lay) { nodes[id].x = x + nodes[id].w / 2; x += nodes[id].w + HGAP; }
  }
  const alignToward = (neigh) => {
    for (const lay of layers) {
      if (lay.length === 0) continue;
      const desired = lay.map((id) => {
        const ns = neigh[id];
        return ns.length ? ns.reduce((a, p) => a + nodes[p].x, 0) / ns.length : nodes[id].x;
      });
      for (let k = 0; k < lay.length; k++) nodes[lay[k]].x = desired[k];
      // Resolve overlaps left→right, preserving order and min gap.
      for (let k = 1; k < lay.length; k++) {
        const prev = nodes[lay[k - 1]], cur = nodes[lay[k]];
        const minX = prev.x + (prev.w + cur.w) / 2 + HGAP;
        if (cur.x < minX) cur.x = minX;
      }
      // Re-center the (now valid) layer on where the neighbors wanted it.
      let want = 0, have = 0;
      for (let k = 0; k < lay.length; k++) { want += desired[k]; have += nodes[lay[k]].x; }
      const shift = (want - have) / lay.length;
      for (const id of lay) nodes[id].x += shift;
    }
  };
  for (let it = 0; it < 6; it++) { alignToward(inc); alignToward(out); }
  return true;
}

// Pack arrow-less bodies into a tidy near-square grid (mutates each center). Six
// loose notes become a 3×2 grid rather than a scattered cloud. Columns share a
// width and rows share a height so everything aligns.
function gridLayout(items) {
  const n = items.length;
  if (n === 0) return;
  if (n === 1) { items[0].x = items[0].w / 2; items[0].y = items[0].h / 2; return; }
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const colW = new Array(cols).fill(0);
  const rowH = new Array(rows).fill(0);
  items.forEach((it, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c], it.w);
    rowH[r] = Math.max(rowH[r], it.h);
  });
  const colX = []; let x = 0;
  for (let c = 0; c < cols; c++) { colX[c] = x + colW[c] / 2; x += colW[c] + GRID_GAP; }
  const rowY = []; let y = 0;
  for (let r = 0; r < rows; r++) { rowY[r] = y + rowH[r] / 2; y += rowH[r] + GRID_GAP; }
  items.forEach((it, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    it.x = colX[c];
    it.y = rowY[r];
  });
}

// Force-directed fallback for cyclic / dense components — the original damped
// spring-electrical solver (repulsion, springs, gravity, crossing + occlusion
// penalties), now operating on a component's local nodes with edges given as
// local index pairs (direction ignored). Startup jitter is deterministic.
function forceLayout(bodies, eidx) {
  const n = bodies.length;
  if (n <= 1) return;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (bodies[i].x === bodies[j].x && bodies[i].y === bodies[j].y) {
        bodies[j].x += (j + 1) * 0.13;
        bodies[j].y += (i + 1) * 0.17;
      }
    }
  }

  const avg = bodies.reduce((a, b) => a + (b.w + b.h) / 2, 0) / n;
  const L = avg + GAP;
  const repK = 0.9 * L * L;
  const springK = 0.5;
  const gravK = 0.9;
  const velDecay = 0.6;
  const minDist = 0.5 * L;
  const maxStep = L;
  const crossK = L * 0.8;
  const occK = L * 0.7;

  const iters = Math.min(800, 350 + n * 14);
  const alphaDecay = 1 - Math.pow(0.001, 1 / iters);
  let alpha = 1;

  const vx = new Array(n).fill(0);
  const vy = new Array(n).fill(0);

  // Deterministic startup jitter to escape symmetric local optima.
  const jitter = L * 0.25;
  for (let i = 0; i < n; i++) {
    bodies[i].x += (hash01(i * 2 + 1) - 0.5) * jitter;
    bodies[i].y += (hash01(i * 2 + 2) - 0.5) * jitter;
  }

  for (let it = 0; it < iters; it++) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += bodies[i].x; cy += bodies[i].y; }
    cx /= n; cy /= n;

    // Repulsion (~1/d), clamped so very-close bodies push gently, not violently.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = bodies[i].x - bodies[j].x;
        let dy = bodies[i].y - bodies[j].y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const eff = dist < minDist ? minDist : dist;
        const f = (repK * alpha) / eff;
        const ux = dx / dist, uy = dy / dist;
        vx[i] += ux * f; vy[i] += uy * f;
        vx[j] -= ux * f; vy[j] -= uy * f;
      }
    }

    // Springs: pull edge endpoints toward rest length L (push apart if closer).
    for (const [i, j] of eidx) {
      const dx = bodies[j].x - bodies[i].x;
      const dy = bodies[j].y - bodies[i].y;
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

    // Edge-crossing penalty: when two edges properly cross, repel their midpoints.
    for (let e1 = 0; e1 < eidx.length; e1++) {
      for (let e2 = e1 + 1; e2 < eidx.length; e2++) {
        const [i1, j1] = eidx[e1];
        const [i2, j2] = eidx[e2];
        if (i1 === i2 || i1 === j2 || j1 === i2 || j1 === j2) continue;

        const A = bodies[i1], B = bodies[j1], C = bodies[i2], D = bodies[j2];
        const abx = B.x - A.x, aby = B.y - A.y;
        const cdx = D.x - C.x, cdy = D.y - C.y;
        const denom = abx * cdy - aby * cdx;
        if (Math.abs(denom) < 1e-8) continue; // parallel / collinear
        const acx = C.x - A.x, acy = C.y - A.y;
        const t = (acx * cdy - acy * cdx) / denom;
        const u = (acx * aby - acy * abx) / denom;
        if (t <= 0.05 || t >= 0.95 || u <= 0.05 || u >= 0.95) continue;

        let ddx = (A.x + B.x) * 0.5 - (C.x + D.x) * 0.5;
        let ddy = (A.y + B.y) * 0.5 - (C.y + D.y) * 0.5;
        const md = Math.hypot(ddx, ddy) || 0.01;
        ddx /= md; ddy /= md;
        const f = crossK * alpha;
        vx[i1] += ddx * f; vy[i1] += ddy * f;
        vx[j1] += ddx * f; vy[j1] += ddy * f;
        vx[i2] -= ddx * f; vy[i2] -= ddy * f;
        vx[j2] -= ddx * f; vy[j2] -= ddy * f;
      }
    }

    // Edge-body occlusion penalty: push bodies away from edges passing close by.
    for (const [i, j] of eidx) {
      const A = bodies[i], B = bodies[j];
      const abx = B.x - A.x, aby = B.y - A.y;
      const len2 = abx * abx + aby * aby;
      if (len2 < 1e-10) continue;

      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const C = bodies[k];
        const t = Math.max(0.1, Math.min(0.9,
          ((C.x - A.x) * abx + (C.y - A.y) * aby) / len2
        ));
        const px = A.x + t * abx, py = A.y + t * aby;
        let ddx = C.x - px, ddy = C.y - py;
        const dist = Math.hypot(ddx, ddy) || 0.01;
        const thresh = (C.w + C.h) * 0.3 + GAP;
        if (dist < thresh) {
          const f = occK * (thresh - dist) / thresh * alpha;
          ddx /= dist; ddy /= dist;
          vx[k] += ddx * f;
          vy[k] += ddy * f;
        }
      }
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

// Hybrid container layout (see file header). Splits bodies into components, lays
// each out with the most human-like strategy that fits (grid for arrow-less
// nodes, layered top-to-bottom for DAGs, force-directed for cyclic/dense graphs),
// then packs the resulting blocks into a grid and separates any overlap.
function layoutBodies(bodies, edges) {
  const n = bodies.length;
  if (n <= 1) return;

  const { comps, loose } = components(bodies, edges);

  // The force solver is O(iters·(N²+E²)) — fine for small clusters but it freezes
  // the main thread on big dense/cyclic ones (measured ~27s at 300 nodes). Cap the
  // component size that may reach it; above the cap, fall back to a layered pass if
  // it applies, else a plain grid (both ~O(N+E)).
  const FORCE_MAX = 100;
  const blocks = []; // each: array of body refs (now positioned in local coords)
  for (const { nodes, edges: localEdges } of comps) {
    const dense = localEdges.length > nodes.length * 2;
    let ok = false;
    if (!dense) ok = layeredLayout(nodes, localEdges);
    if (!ok) {
      if (nodes.length <= FORCE_MAX) forceLayout(nodes, localEdges);
      else if (!layeredLayout(nodes, localEdges)) gridLayout(nodes);
    }
    blocks.push(nodes);
  }
  // All arrow-less bodies share one grid block.
  if (loose.length) { gridLayout(loose); blocks.push(loose); }

  // Pack the independent blocks into a grid of blocks (they share no arrows, so
  // alignment is all that matters). Translate each block's bodies into place.
  const boxes = blocks.map((nodes) => ({ nodes, box: bboxOf(nodes) }));
  const cols = Math.max(1, Math.ceil(Math.sqrt(boxes.length)));
  let bx = 0, by = 0, rowH = 0;
  boxes.forEach((blk, i) => {
    if (i > 0 && i % cols === 0) { by += rowH + BLOCK_GAP; bx = 0; rowH = 0; }
    const dx = bx - blk.box.minX, dy = by - blk.box.minY;
    for (const nd of blk.nodes) { nd.x += dx; nd.y += dy; }
    bx += blk.box.w + BLOCK_GAP;
    rowH = Math.max(rowH, blk.box.h);
  });

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
//
// `opts.sizeNote(content, node) -> {w,h} | null` (optional) auto-sizes each note
// from its content before layout — used by the CLI `arrange` so agent-generated
// boards don't cram a wall of text into a default box. It is applied *after*
// section membership is computed (see below), so a note that grows to fit its
// text never spills out of its section; the section is re-sized to wrap it.
export function arrangeBoard(model, opts = {}) {
  const nodes = (model.nodes || []).map((n) => ({ ...n }));
  const sections = (model.sections || []).map((s) => ({ ...s }));
  const connections = model.connections || [];

  const sById = new Map(sections.map((s) => [s.id, s]));
  const nById = new Map(nodes.map((n) => [n.id, n]));

  // Immediate parent of each note (smallest containing section) and section
  // (smallest strictly-containing section), mirroring the storage containment rule.
  // Computed from the *original* geometry — before any auto-sizing — so growing a
  // note to fit its text can't bump it out of the section it belongs to.
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

  // Now that membership is fixed, auto-size notes from their content if asked.
  // Sizing after membership keeps every note inside its section: Phase A lays the
  // (possibly larger) note out within its parent and grows the section to wrap it.
  if (typeof opts.sizeNote === "function") {
    for (const n of nodes) {
      const size = opts.sizeNote(n.content, n);
      if (size) { n.w = size.w; n.h = size.h; }
    }
  }

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
  // Directed edges [from, to] between bodies at this container's level. Direction
  // is preserved (the layered layout reads from→to as above→below); duplicate
  // arrows in the same direction collapse to one, but A→B and B→A both survive so
  // a true cycle is visible to the layout (and routes it to the force fallback).
  function edgesFor(bodyList) {
    const idSet = new Set(bodyList.map((b) => b.id));
    const seen = new Set();
    const edges = [];
    for (const c of connections) {
      const a = bodyInContainer(c.from, idSet);
      const b = bodyInContainer(c.to, idSet);
      if (a && b && a !== b) {
        const key = a + ">" + b;
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
