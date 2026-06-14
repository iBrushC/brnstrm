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
let boxSel = null;

// Show grab cursor while Shift is held (signals pan mode is available).
document.addEventListener("keydown", (e) => {
  if (e.key === "Shift" && !panning) canvas.classList.add("shift-held");
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Shift") canvas.classList.remove("shift-held");
});

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest("#hud")) return;
  // Clicking empty canvas while aiming an arrow cancels the pending connect.
  if (connections && connections.isConnecting() && !e.target.closest(".node")) {
    connections.cancelConnect();
    return;
  }

  if (e.shiftKey) {
    // Shift + drag = pan
    panning = true;
    startX = e.clientX - view.x;
    startY = e.clientY - view.y;
    canvas.classList.add("panning");
    canvas.classList.remove("shift-held");
  } else {
    // Plain drag on empty canvas = marquee box selection
    const r = canvas.getBoundingClientRect();
    const startWorld = screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const previewEl = document.createElement("div");
    previewEl.id = "box-select";
    canvas.appendChild(previewEl);
    boxSel = { startWorld, startScreen: { x: e.clientX, y: e.clientY }, previewEl, canvasRect: r };
    canvas.classList.add("box-selecting");
  }
});

window.addEventListener("mousemove", (e) => {
  if (panning) {
    view.x = e.clientX - startX;
    view.y = e.clientY - startY;
    render();
  }
  if (boxSel) {
    const x = Math.min(e.clientX, boxSel.startScreen.x) - boxSel.canvasRect.left;
    const y = Math.min(e.clientY, boxSel.startScreen.y) - boxSel.canvasRect.top;
    const w = Math.abs(e.clientX - boxSel.startScreen.x);
    const h = Math.abs(e.clientY - boxSel.startScreen.y);
    boxSel.previewEl.style.left = x + "px";
    boxSel.previewEl.style.top = y + "px";
    boxSel.previewEl.style.width = w + "px";
    boxSel.previewEl.style.height = h + "px";
  }
});

window.addEventListener("mouseup", (e) => {
  if (panning) {
    panning = false;
    canvas.classList.remove("panning");
    if (e.shiftKey) canvas.classList.add("shift-held");
    scheduleCameraSave();
  }
  if (boxSel) {
    canvas.classList.remove("box-selecting");
    boxSel.previewEl.remove();
    const r = boxSel.canvasRect;
    const endWorld = screenToWorld(e.clientX - r.left, e.clientY - r.top);
    const selRect = {
      x: Math.min(boxSel.startWorld.x, endWorld.x),
      y: Math.min(boxSel.startWorld.y, endWorld.y),
      w: Math.abs(endWorld.x - boxSel.startWorld.x),
      h: Math.abs(endWorld.y - boxSel.startWorld.y),
    };
    if (selRect.w > 4 && selRect.h > 4) {
      if (nodeLayer) nodeLayer.selectInRect(selRect);
      if (sections) sections.selectInRect(selRect);
    } else {
      // Tiny drag = click — clear any existing group selection
      if (nodeLayer) nodeLayer.clearGroupSel();
      if (sections) sections.clearGroupSel();
    }
    boxSel = null;
  }
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
// press point; the others instead enter a follow-up interaction mode (drag a
// rectangle / drag between two things), so their onPick ignores the point.
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
  return (
    el &&
    (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)
  );
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
  onGroupDragStart: () => sections && sections.captureGroupOrigins(),
  onGroupDragMove: (dx, dy) => sections && sections.applyGroupOffset(dx, dy),
  onGroupDragEnd: () => sections && sections.commitGroupMove(),
});

sections = createSectionLayer({
  layer: sectionLayerEl,
  canvas,
  getBoardId: () => boards.current(),
  onChange: refresh,
  history,
  onGroupDragStart: () => nodeLayer && nodeLayer.captureGroupOrigins(),
  onGroupDragMove: (dx, dy) => nodeLayer && nodeLayer.applyGroupOffset(dx, dy),
  onGroupDragEnd: () => nodeLayer && nodeLayer.commitGroupMove(),
  onSectionDragStart: (section) => nodeLayer && nodeLayer.captureNodesInRect(section),
  onSectionDragMove: (dx, dy) => nodeLayer && nodeLayer.applyContainedOffset(dx, dy),
  onSectionDragEnd: () => nodeLayer && nodeLayer.commitContainedMove(),
  // Deleting a section drops the arrows that linked it (UI side; server prunes too).
  onDelete: (sectionId) => connections && connections.removeForSection(sectionId),
});

connections = createConnectionLayer({
  svg: connectionSvg,
  labelLayer: connLabelsEl,
  canvas,
  getBoardId: () => boards.current(),
  getNodeRect: (id) => nodeLayer.getNodeRect(id),
  getSectionRect: (id) => sections.getSectionRect(id),
  getSectionAt: (wx, wy) => sections.sectionAtWorld(wx, wy),
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

/* ---------------- File drop → resource + node ---------------- */
// Dragging files onto the canvas uploads each to the board's resources folder
// and drops a node at the cursor whose body is just a "@[file]" reference
// (which renders as an image preview or a file chip). A depth counter keeps the
// drop-zone highlight stable as the drag passes over child elements.
let dragDepth = 0;

function showInfoToast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  const msg = document.createElement("span");
  msg.textContent = message;
  el.appendChild(msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Only react to drags that actually carry files (ignore in-canvas element drags).
function hasFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes("Files");
}

// Stop the browser from opening a file that's dropped anywhere off the canvas.
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (hasFiles(e)) e.preventDefault();
});

canvas.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  canvas.classList.add("drag-over");
});

canvas.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

canvas.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) canvas.classList.remove("drag-over");
});

canvas.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  canvas.classList.remove("drag-over");

  const id = boards.current();
  const files = Array.from(e.dataTransfer.files || []);
  if (!id || files.length === 0) return;

  // Anchor the first node at the drop point; stack the rest down-right so a
  // multi-file drop doesn't pile every node on the same spot.
  const r = canvas.getBoundingClientRect();
  const drop = screenToWorld(e.clientX - r.left, e.clientY - r.top);

  let ok = 0;
  let failed = 0;
  let i = 0;
  for (const f of files) {
    try {
      // Use the saved name (the server de-dupes), so the "@[name]" reference
      // always matches the file actually on disk.
      const saved = await api.uploadResource(id, f);
      const offset = i * 28;
      await nodeLayer.createNodeAt(drop.x + offset, drop.y + offset, {
        content: "@[" + saved.name + "]",
      });
      ok++;
    } catch (err) {
      console.error(err);
      failed++;
    }
    i++;
  }

  let msg = ok === 1 ? "Added 1 file" : "Added " + ok + " files";
  if (failed) msg += " · " + failed + " failed";
  showInfoToast(msg);
});

await boards.load();
