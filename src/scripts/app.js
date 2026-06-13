// brnstrm — app orchestrator: theme, canvas pan/zoom, minimap, and wiring of
// the board + node modules.

import { view, screenToWorld } from "./view.js";
import { api } from "./api.js";
import { createNodeLayer } from "./nodes.js";
import { createSectionLayer } from "./sections.js";
import { createConnectionLayer } from "./connections.js";
import { createBoardBar } from "./boards.js";
import { createHistory } from "./history.js";
import { createRadialMenu } from "./radial.js";

/* ---------------- Theme ---------------- */
const root = document.documentElement;
const themeBtn = document.getElementById("theme-toggle");
const themeLabel = themeBtn.querySelector(".theme-label");

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  themeLabel.textContent = "theme: " + theme;
  try {
    localStorage.setItem("brnstrm-theme", theme);
  } catch (_) {}
  drawMinimap(); // minimap colors are theme-derived
}

themeBtn.addEventListener("click", () => {
  applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

/* ---------------- Canvas refs ---------------- */
const canvas = document.getElementById("canvas");
const grid = document.getElementById("grid");
const viewport = document.getElementById("viewport");
const zoomLabel = document.getElementById("zoom-level");
const minimap = document.getElementById("minimap");
const mmCtx = minimap.getContext("2d");

const GRID_SIZE = 24;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

// Stacked layers inside the (transformed) viewport, back to front.
const sectionLayerEl = document.getElementById("section-layer");
const connectionSvg = document.getElementById("connection-layer");
const connLabelsEl = document.getElementById("conn-labels");
const nodeLayerEl = document.getElementById("node-layer");

let nodeLayer; // set during init
let sections; // set during init
let connections; // set during init

// Single change hook shared by node/section edits: keep the minimap fresh and
// re-route arrows so they track the nodes they connect.
function refresh() {
  drawMinimap();
  if (connections) connections.redraw();
}

function render() {
  viewport.style.transform =
    "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";

  const size = GRID_SIZE * view.scale;
  grid.style.setProperty("--grid-size", size + "px");
  grid.style.setProperty("--grid-x", (view.x % size) + "px");
  grid.style.setProperty("--grid-y", (view.y % size) + "px");

  zoomLabel.textContent = Math.round(view.scale * 100) + "%";
  drawMinimap();
}

/* ---------------- Minimap ---------------- */
function visibleWorldRect() {
  const r = canvas.getBoundingClientRect();
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(r.width, r.height);
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

function drawMinimap() {
  if (!nodeLayer) return;
  const W = minimap.width;
  const H = minimap.height;
  mmCtx.clearRect(0, 0, W, H);

  const rects = nodeLayer.getRects();
  const sectionRects = sections ? sections.getRects() : [];
  const vis = visibleWorldRect();

  // Fit the union of nodes + sections + the visible region, with padding.
  let minX = vis.x,
    minY = vis.y,
    maxX = vis.x + vis.w,
    maxY = vis.y + vis.h;
  for (const n of [...rects, ...sectionRects]) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const pad = 40;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  const s = Math.min(W / bw, H / bh);
  const offX = (W - bw * s) / 2 - (minX - pad) * s;
  const offY = (H - bh * s) / 2 - (minY - pad) * s;
  const mm = (x, y) => ({ x: x * s + offX, y: y * s + offY });

  const style = getComputedStyle(root);
  // Sections (outlined, behind nodes)
  mmCtx.strokeStyle = style.getPropertyValue("--border").trim() || "#2c2f38";
  mmCtx.lineWidth = 1;
  for (const sec of sectionRects) {
    const p = mm(sec.x, sec.y);
    mmCtx.strokeRect(p.x, p.y, Math.max(2, sec.w * s), Math.max(2, sec.h * s));
  }
  // Nodes
  mmCtx.fillStyle = style.getPropertyValue("--accent").trim() || "#6ea8fe";
  for (const n of rects) {
    const p = mm(n.x, n.y);
    mmCtx.fillRect(p.x, p.y, Math.max(2, n.w * s), Math.max(2, n.h * s));
  }
  // Current viewport indicator
  const a = mm(vis.x, vis.y);
  mmCtx.strokeStyle = style.getPropertyValue("--text-dim").trim() || "#888";
  mmCtx.lineWidth = 1;
  mmCtx.strokeRect(a.x, a.y, vis.w * s, vis.h * s);
}

// Recenter: fit all nodes in view, or reset to origin if the board is empty.
function recenter() {
  const r = canvas.getBoundingClientRect();
  const rects = [
    ...nodeLayer.getRects(),
    ...(sections ? sections.getRects() : []),
  ];
  if (rects.length === 0) {
    view.scale = 1;
    view.x = r.width / 2;
    view.y = r.height / 2;
    render();
    return;
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of rects) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const pad = 80;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(r.width / bw, r.height / bh)));
  view.x = r.width / 2 - ((minX + maxX) / 2) * view.scale;
  view.y = r.height / 2 - ((minY + maxY) / 2) * view.scale;
  render();
}

document.getElementById("recenter").addEventListener("click", recenter);

/* ---------------- Pan & zoom ---------------- */
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const ratio = next / view.scale;
    view.x = cx - (cx - view.x) * ratio;
    view.y = cy - (cy - view.y) * ratio;
    view.scale = next;
    render();
    scheduleCameraSave();
  },
  { passive: false }
);

let panning = false;
let startX = 0;
let startY = 0;

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest("#hud")) return;
  // Clicking empty canvas while aiming an arrow cancels the pending connect.
  if (connections && connections.isConnecting() && !e.target.closest(".node")) {
    connections.cancelConnect();
  }
  panning = true;
  startX = e.clientX - view.x;
  startY = e.clientY - view.y;
  canvas.classList.add("panning");
});

window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  view.x = e.clientX - startX;
  view.y = e.clientY - startY;
  render();
});

window.addEventListener("mouseup", () => {
  panning = false;
  canvas.classList.remove("panning");
  if (!panning) scheduleCameraSave();
});

// Don't let HUD interactions start a pan.
document.getElementById("hud").addEventListener("mousedown", (e) => e.stopPropagation());

/* ---------------- Help guide ---------------- */
const helpBtn = document.getElementById("help-btn");
const helpGuide = document.getElementById("help-guide");
const helpClose = document.getElementById("help-close");

helpBtn.addEventListener("mousedown", (e) => e.stopPropagation());
helpGuide.addEventListener("mousedown", (e) => e.stopPropagation());

helpBtn.addEventListener("click", () => {
  const visible = helpGuide.classList.toggle("visible");
  helpBtn.classList.toggle("active", visible);
});

helpClose.addEventListener("click", () => {
  helpGuide.classList.remove("visible");
  helpBtn.classList.remove("active");
});

/* ---------------- Camera persistence ---------------- */
let cameraSaveTimer = null;
function scheduleCameraSave() {
  clearTimeout(cameraSaveTimer);
  cameraSaveTimer = setTimeout(() => {
    const id = boards && boards.current();
    if (id) {
      api
        .saveBoardCamera(id, { x: view.x, y: view.y, scale: view.scale })
        .catch(() => {});
    }
  }, 400);
}

/* ---------------- Undo history ---------------- */
const history = createHistory();

/* ---------------- Radial add menu ---------------- */
// Each quarter spawns a different kind of thing. "Note" spawns instantly at the
// press point; "Section" and "Arrow" instead enter a follow-up interaction mode
// (drag a rectangle / click two nodes), so their onPick ignores the point.
const radial = createRadialMenu({
  container: canvas,
  options: [
    {
      id: "note",
      label: "Note",
      position: "top",
      onPick: (p) => nodeLayer && nodeLayer.spawnAtWorld(p.x, p.y),
    },
    {
      id: "section",
      label: "Section",
      position: "left",
      onPick: () => sections && sections.beginDraw(),
    },
    {
      id: "arrow",
      label: "Arrow",
      position: "right",
      onPick: () => connections && connections.beginConnect(),
    },
  ],
});

/* ---------------- Node keybinds ---------------- */
let lastMouse = { x: 0, y: 0 }; // canvas-relative

canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  lastMouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (radial.isOpen()) radial.update(lastMouse.x, lastMouse.y);
});

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
}

window.addEventListener("keydown", (e) => {
  // Hold 'a' to open the radial menu at the cursor; aim, then release to add.
  // The node spawns where the menu opened, so capture that world point now.
  if (
    e.key === "a" &&
    !e.repeat &&
    !isTyping() &&
    !e.metaKey &&
    !e.ctrlKey &&
    nodeLayer &&
    !radial.isOpen()
  ) {
    radial.show(lastMouse.x, lastMouse.y, screenToWorld(lastMouse.x, lastMouse.y));
    return;
  }

  // Undo (Ctrl/Cmd+Z) — currently restores deleted nodes.
  if (
    (e.key === "z" || e.key === "Z") &&
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !isTyping()
  ) {
    e.preventDefault();
    history.undo();
    return;
  }

  // Delete the selected thing — try node, then section, then arrow.
  if ((e.key === "Delete" || e.key === "Backspace") && !isTyping() && nodeLayer) {
    if (
      nodeLayer.deleteSelected() ||
      (sections && sections.deleteSelected()) ||
      (connections && connections.deleteSelected())
    ) {
      e.preventDefault();
    }
    return;
  }

  if (e.key === "?" && !isTyping()) {
    const visible = helpGuide.classList.toggle("visible");
    helpBtn.classList.toggle("active", visible);
  }
  if (e.key === "Escape") {
    if (radial.isOpen()) {
      radial.cancel();
      return;
    }
    // Bail out of an in-progress section draw or arrow connect.
    if (sections && sections.isDrawing()) {
      sections.cancelDraw();
      return;
    }
    if (connections && connections.isConnecting()) {
      connections.cancelConnect();
      return;
    }
    if (helpGuide.classList.contains("visible")) {
      helpGuide.classList.remove("visible");
      helpBtn.classList.remove("active");
    }
  }
});

// Release 'a' to commit the radial selection (or cancel if aimed at nothing).
window.addEventListener("keyup", (e) => {
  if (e.key === "a" && radial.isOpen()) radial.release();
});

/* ---------------- Init ---------------- */
(function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("brnstrm-theme");
  } catch (_) {}
  applyTheme(saved || "dark");
})();

nodeLayer = createNodeLayer({
  viewport: nodeLayerEl,
  getBoardId: () => boards.current(),
  onChange: refresh,
  history,
  // In connect mode, a node press starts dragging an arrow instead of moving.
  isLocked: () => connections && connections.isConnecting(),
  onNodeClick: (node) => connections && connections.startDragFrom(node),
  onDelete: (nodeId) => connections && connections.removeForNode(nodeId),
});

sections = createSectionLayer({
  layer: sectionLayerEl,
  canvas,
  getBoardId: () => boards.current(),
  onChange: refresh,
  history,
});

connections = createConnectionLayer({
  svg: connectionSvg,
  labelLayer: connLabelsEl,
  canvas,
  getBoardId: () => boards.current(),
  getNodeRect: (id) => nodeLayer.getNodeRect(id),
  onChange: drawMinimap,
  history,
});

const boards = createBoardBar({
  listEl: document.getElementById("board-list"),
  addBtn: document.getElementById("add-board"),
  onSwitch: async (id) => {
    try {
      const data = await api.getBoard(id);
      nodeLayer.load(data.nodes);
      sections.load(data.sections);
      connections.load(data.connections);
      if (data.camera && typeof data.camera.x === "number") {
        view.x = data.camera.x;
        view.y = data.camera.y;
        view.scale = data.camera.scale;
        render();
      } else {
        recenter();
      }
    } catch (err) {
      console.error(err);
      render();
    }
  },
});

await boards.load();
