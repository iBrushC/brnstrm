#!/usr/bin/env node
// brnstrm agent CLI — a headless entry point so coding agents can read and write
// boards without the browser or a running server. Every mutation goes through
// storage.js (the same code the HTTP API uses), so slugging, section folder
// reconciliation, and connection pruning stay correct and identical to the UI.
//
// Reading reuses board-format.mjs — the exact deterministic formatter the in-app
// "export to LLM" button uses — so what an agent reads matches what a human sees.
//
// Reversibility: this is a git-tracked data store (boards live under data/ as
// plain files), so the durable undo is `git`. Every mutating command also prints
// the created/affected ids as JSON, so an agent can immediately reverse its own
// edit with the matching rm-*/set-* command.
//
// Usage:
//   node bin/brnstrm.mjs <command> [args]
// Run with no command (or `help`) for the full command list.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import storage from "../storage.js";
import {
  formatBoard,
  formatSection,
  formatNote,
  nodeName,
} from "../src/scripts/board-format.mjs";
import { arrangeBoard, autoSizeNote } from "../src/scripts/board-layout.mjs";

/* ---------------- tiny arg parser ---------------- */
// Splits argv into positionals and --key value / --flag pairs. Values that look
// like the next flag are treated as boolean flags (e.g. trailing --section).
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

function fail(msg) {
  process.stderr.write("error: " + msg + "\n");
  process.exit(1);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

// Resolve a board reference (id / folder slug / display name) to its id, or exit.
function boardIdOrFail(ref) {
  if (!ref) fail("a board (id or name) is required");
  const id = storage.resolveBoardId(ref);
  if (!id) fail(`no board matches "${ref}" — run \`list\` to see boards`);
  // Warn (don't fail) when a display name is shared by several boards, so a write
  // doesn't silently land on the wrong one. An exact id ref is never ambiguous.
  const all = storage.listBoards();
  if (!all.some((b) => b.id === ref)) {
    const lower = String(ref).toLowerCase();
    const sameName = all.filter((b) => (b.name || "").toLowerCase() === lower);
    if (sameName.length > 1) {
      process.stderr.write(
        `warning: "${ref}" matches ${sameName.length} boards — using ${id}. ` +
          `Disambiguate by id: ${sameName.map((b) => b.id).join(", ")}\n`
      );
    }
  }
  return id;
}

// Content can be inline (--content "..."), from a file (--content-file path),
// or piped on stdin (--content -). Files/stdin keep markdown bodies readable.
function resolveContent(opts) {
  if (opts["content-file"] && opts["content-file"] !== true) {
    return fs.readFileSync(String(opts["content-file"]), "utf8");
  }
  if (opts.content === "-" || opts["content-stdin"]) {
    return fs.readFileSync(0, "utf8");
  }
  if (typeof opts.content === "string") return opts.content;
  return undefined;
}

/* ---------------- geometry / templated placement ---------------- */
const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
const rectInside = (outer, inner) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

const PAD = 32; // breathing room inside a section box
const GAP = 24; // gap between tiled notes
const HEADER = 44; // space reserved under a section's label

// Find a section on the board by id, slug, or label (case-insensitive).
function findSection(model, ref) {
  const want = String(ref).toLowerCase();
  return (
    model.sections.find((s) => s.id === ref) ||
    model.sections.find((s) => (s.slug || "").toLowerCase() === want) ||
    model.sections.find((s) => (s.label || "").toLowerCase() === want) ||
    null
  );
}

// Notes whose box falls inside this section and no smaller one — the notes the
// section "owns", which is what we tile against when placing a new one.
function notesOwnedBy(model, section) {
  return model.nodes.filter((n) => {
    const inside = model.sections.filter((s) => rectInside(s, n));
    if (!inside.length) return false;
    inside.sort((a, b) => area(a) - area(b));
    return inside[0].id === section.id;
  });
}

// Next free grid slot inside a section for a w×h note, tiling left→right,
// top→bottom past the notes already there. Columns derive from section width so
// placed notes never spill past the right edge.
function slotInSection(section, count, w, h) {
  const usableW = Math.max(w, section.w - PAD * 2);
  const cols = Math.max(1, Math.floor((usableW + GAP) / (w + GAP)));
  const row = Math.floor(count / cols);
  const col = count % cols;
  return {
    x: section.x + PAD + col * (w + GAP),
    y: section.y + HEADER + PAD + row * (h + GAP),
  };
}

// Grow a section so a child note at (x,y,w,h) fits with padding. Returns a patch
// (or null) to feed updateSection.
function growToFit(section, child) {
  const needRight = child.x + child.w + PAD;
  const needBottom = child.y + child.h + PAD;
  const patch = {};
  if (needRight > section.x + section.w) patch.w = needRight - section.x;
  if (needBottom > section.y + section.h) patch.h = needBottom - section.y;
  return Object.keys(patch).length ? patch : null;
}

// Right edge of everything on the board — a sensible default x for new content
// so fresh notes/sections don't land on top of existing ones.
function rightEdge(model) {
  let max = 0;
  for (const r of [...model.nodes, ...model.sections]) {
    max = Math.max(max, r.x + r.w);
  }
  return max;
}

/* ---------------- connection endpoint resolution ---------------- */
// Resolve a --from/--to reference to { id, kind } by trying ids, then node
// names/slugs, then section labels/slugs. So an agent can write
// `connect board --from "Agent Review" --to "Knowledge Bases"` by name.
function resolveEndpoint(model, ref) {
  // An exact id is unambiguous — take it directly.
  const idNode = model.nodes.find((n) => n.id === ref);
  if (idNode) return { id: idNode.id, kind: "node" };
  const idSec = model.sections.find((s) => s.id === ref);
  if (idSec) return { id: idSec.id, kind: "section" };

  const want = String(ref).toLowerCase();
  const nodes = model.nodes.filter(
    (n) =>
      (n.name || "").toLowerCase() === want ||
      (n.slug || "").toLowerCase() === want ||
      nodeName(n).toLowerCase() === want
  );
  const sections = model.sections.filter(
    (s) =>
      (s.slug || "").toLowerCase() === want ||
      (s.label || "").toLowerCase() === want
  );
  const matches = [
    ...nodes.map((n) => ({ id: n.id, kind: "node", label: nodeName(n) })),
    ...sections.map((s) => ({ id: s.id, kind: "section", label: (s.label || "").trim() || s.id })),
  ];
  if (!matches.length) return null;
  // Don't silently wire the wrong endpoint when a name is shared — warn and list
  // the candidate ids so the agent can re-issue with an exact id.
  if (matches.length > 1) {
    process.stderr.write(
      `warning: "${ref}" matches ${matches.length} things — using ${matches[0].id}. ` +
        `Disambiguate by id: ${matches.map((m) => `${m.id} (${m.kind} "${m.label}")`).join(", ")}\n`
    );
  }
  return { id: matches[0].id, kind: matches[0].kind };
}

/* ---------------- commands ---------------- */
const commands = {
  help() {
    process.stdout.write(HELP);
  },

  // Reading. Whole board, one --section, or one --note → agent-ready markdown.
  read({ positional, opts }) {
    const id = boardIdOrFail(positional[0]);
    const board = storage.getBoard(id);
    const model = {
      nodes: board.nodes,
      sections: board.sections,
      connections: board.connections,
      // Comments ride along so an agent revising a plan sees the human's feedback
      // inline under each note/section (read-only — agents never write comments).
      comments: board.comments,
    };
    if (opts.section && opts.section !== true) {
      const sec = findSection(model, opts.section);
      if (!sec) fail(`no section matches "${opts.section}"`);
      process.stdout.write(formatSection(sec.id, model));
      return;
    }
    if (opts.note && opts.note !== true) {
      const want = String(opts.note).toLowerCase();
      const byId = model.nodes.find((n) => n.id === opts.note);
      const byName = model.nodes.filter((n) => (n.name || "").toLowerCase() === want);
      const node = byId || byName[0];
      if (!node) fail(`no note matches "${opts.note}"`);
      if (!byId && byName.length > 1) {
        process.stderr.write(
          `warning: "${opts.note}" matches ${byName.length} notes — using ${node.id}. ` +
            `Disambiguate by id: ${byName.map((n) => n.id).join(", ")}\n`
        );
      }
      process.stdout.write(formatNote(node, model.comments));
      return;
    }
    process.stdout.write(formatBoard(board.name, model));
  },

  // Read-only view of the user's comments. Agents can read comments (to revise
  // plans) but never create them — there is deliberately no add/rm command.
  comments({ positional, opts }) {
    const id = boardIdOrFail(positional[0]);
    const board = storage.getBoard(id);
    let list = board.comments || [];
    // Optional scope to one note/section (by id or name), mirroring `read`.
    if (opts.note && opts.note !== true) {
      const want = String(opts.note).toLowerCase();
      const node =
        board.nodes.find((n) => n.id === opts.note) ||
        board.nodes.find((n) => (n.name || "").toLowerCase() === want);
      if (!node) fail(`no note matches "${opts.note}"`);
      list = list.filter((c) => c.targetId === node.id);
    } else if (opts.section && opts.section !== true) {
      const sec = findSection(
        { nodes: board.nodes, sections: board.sections, connections: board.connections },
        opts.section
      );
      if (!sec) fail(`no section matches "${opts.section}"`);
      list = list.filter((c) => c.targetId === sec.id);
    }
    if (!list.length) {
      process.stdout.write("(no comments on this board)\n");
      return;
    }
    // Group by target, labelling each with its note/section name for context.
    const nameById = new Map();
    for (const n of board.nodes) nameById.set(n.id, nodeName(n));
    for (const s of board.sections) nameById.set(s.id, (s.label || "").trim() || s.id);
    const byTarget = new Map();
    for (const c of list) {
      const arr = byTarget.get(c.targetId) || [];
      arr.push(c);
      byTarget.set(c.targetId, arr);
    }
    for (const [targetId, arr] of byTarget) {
      const kind = arr[0].targetKind === "section" ? "Section" : "Note";
      process.stdout.write(`${kind}: ${nameById.get(targetId) || targetId} <!-- ${targetId} -->\n`);
      for (const c of arr.slice().sort((a, b) => a.n - b.n)) {
        const who = ((c.author || "").trim()) || "anonymous";
        const when = c.created ? ` · ${c.created}` : "";
        const text = (c.text || "").trim().replace(/\s*\n\s*/g, " ");
        process.stdout.write(`  - ${who}${when}: ${text}\n`);
      }
      process.stdout.write("\n");
    }
  },

  list() {
    const boards = storage.listBoards();
    if (!boards.length) {
      process.stdout.write("(no boards yet — create one with `new-board <name>`)\n");
      return;
    }
    for (const b of boards) process.stdout.write(`${b.id}\t${b.name}\n`);
  },

  // Synthesis — agents create whole boards from scratch.
  "new-board"({ positional }) {
    const name = positional.join(" ").trim();
    if (!name) fail("a board name is required: new-board <name>");
    out(storage.createBoard(name));
  },

  "rename-board"({ positional }) {
    const id = boardIdOrFail(positional[0]);
    const name = positional.slice(1).join(" ").trim();
    if (!name) fail("a new name is required");
    out(storage.renameBoard(id, name));
  },

  "delete-board"({ positional }) {
    const id = boardIdOrFail(positional[0]);
    out(storage.deleteBoard(id));
  },

  // Writing — add a note. With --section it's templated: geometry is computed to
  // drop the note into a free slot inside that section, growing the section to
  // fit, so agents never have to reason about pixel coordinates.
  "add-note"({ positional, opts }) {
    const id = boardIdOrFail(positional[0]);
    const content = resolveContent(opts) ?? "";
    const name = opts.name && opts.name !== true ? String(opts.name) : "";
    const w = Number(opts.w) || 280;
    const h = Number(opts.h) || 160;
    const model = boardModel(id);

    let x = Number(opts.x);
    let y = Number(opts.y);
    let grow = null;
    let section = null;
    if (opts.section && opts.section !== true && !(Number.isFinite(x) && Number.isFinite(y))) {
      section = findSection(model, opts.section);
      if (!section) fail(`no section matches "${opts.section}"`);
      const count = notesOwnedBy(model, section).length;
      const slot = slotInSection(section, count, w, h);
      x = slot.x;
      y = slot.y;
      grow = growToFit(section, { x, y, w, h });
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // No section, no coords: drop it to the right of existing content.
      x = rightEdge(model) + GAP;
      y = 0;
    }

    const node = storage.createNode(id, { name, content, x, y, w, h });
    if (grow && section) storage.updateSection(id, section.id, grow);
    out({ ...node, section: section ? section.id : null });
  },

  "set-note"({ positional, opts }) {
    const id = boardIdOrFail(positional[0]);
    const nodeId = positional[1];
    if (!nodeId) fail("a node id is required: set-note <board> <node-id> [...]");
    const patch = {};
    for (const k of ["x", "y", "w", "h"]) {
      if (opts[k] !== undefined) patch[k] = Number(opts[k]);
    }
    if (opts.name !== undefined) patch.name = String(opts.name);
    const content = resolveContent(opts);
    if (content !== undefined) patch.content = content;
    out(storage.updateNode(id, nodeId, patch));
  },

  "rm-note"({ positional }) {
    const id = boardIdOrFail(positional[0]);
    if (!positional[1]) fail("a node id is required");
    out(storage.deleteNode(id, positional[1]));
  },

  // Writing — add a section. Defaults place it right of existing content.
  "add-section"({ positional, opts }) {
    const id = boardIdOrFail(positional[0]);
    const label = opts.label && opts.label !== true ? String(opts.label) : "";
    const model = boardModel(id);
    const x = Number.isFinite(Number(opts.x)) ? Number(opts.x) : rightEdge(model) + GAP;
    const y = Number.isFinite(Number(opts.y)) ? Number(opts.y) : 0;
    const w = Number(opts.w) || 420;
    const h = Number(opts.h) || 320;
    out(storage.createSection(id, { label, x, y, w, h }));
  },

  "set-section"({ positional, opts }) {
    const id = boardIdOrFail(positional[0]);
    const sectionId = positional[1];
    if (!sectionId) fail("a section id is required");
    const patch = {};
    for (const k of ["x", "y", "w", "h"]) {
      if (opts[k] !== undefined) patch[k] = Number(opts[k]);
    }
    if (opts.label !== undefined) patch.label = String(opts.label);
    out(storage.updateSection(id, sectionId, patch));
  },

  "rm-section"({ positional }) {
    const id = boardIdOrFail(positional[0]);
    if (!positional[1]) fail("a section id is required");
    out(storage.deleteSection(id, positional[1]));
  },

  // Writing — connect two things by id or name. Kind is inferred (section arrows
  // resolve against section rects); pass --label to name the relationship.
  connect({ positional, opts }) {
    const id = boardIdOrFail(positional[0]);
    const model = boardModel(id);
    const from = resolveEndpoint(model, opts.from);
    const to = resolveEndpoint(model, opts.to);
    if (!from) fail(`--from "${opts.from}" matched no note or section`);
    if (!to) fail(`--to "${opts.to}" matched no note or section`);
    const data = { from: from.id, to: to.id };
    if (opts.label && opts.label !== true) data.label = String(opts.label);
    if (from.kind === "section" && to.kind === "section") data.kind = "section";
    else if (from.kind !== to.kind) {
      process.stderr.write(
        "note: connecting a note to a section — the canvas resolves arrows by a " +
          "single kind, so this may render against unexpected endpoints.\n"
      );
    }
    out(storage.createConnection(id, data));
  },

  "rm-connection"({ positional }) {
    const id = boardIdOrFail(positional[0]);
    if (!positional[1]) fail("a connection id is required");
    out(storage.deleteConnection(id, positional[1]));
  },

  // Reference files attached to a board (the "File Access" capability).
  resources({ positional }) {
    const id = boardIdOrFail(positional[0]);
    const list = storage.listResources(id);
    if (!list.length) {
      process.stdout.write("(no reference files on this board)\n");
      return;
    }
    for (const r of list) process.stdout.write(`${r.name}\t${r.size} bytes\n`);
  },

  "read-resource"({ positional }) {
    const id = boardIdOrFail(positional[0]);
    const name = positional[1];
    if (!name) fail("a resource filename is required");
    const hit = storage.resolveResource(id, name);
    if (!hit) fail(`no resource named "${name}" on this board`);
    if (/^text\/|json|svg|csv|markdown/.test(hit.mime)) {
      process.stdout.write(fs.readFileSync(hit.file, "utf8"));
    } else {
      const size = fs.statSync(hit.file).size;
      process.stdout.write(
        `[binary ${hit.mime}, ${size} bytes] ${hit.file}\n` +
          "(non-text resource — read it from the path above with an appropriate tool)\n"
      );
    }
  },

  // Auto-arrange — arrow-aware force-directed layout. Reflows notes so connected
  // ones sit together, keeps each note inside its section, and positions sections
  // by the arrows between them. Unlike `format` this *moves* things; the board is
  // git-tracked, so `git diff data/` shows exactly what moved and reverts it.
  arrange({ positional }) {
    const id = boardIdOrFail(positional[0]);
    const model = boardModel(id);
    if (!model.nodes.length && !model.sections.length) {
      out({ ok: true, board: id, moved: 0 });
      return;
    }
    // Snapshot the original geometry before auto-sizing so we can tell which
    // notes actually changed (the resize below mutates model.nodes in place).
    const nodeById = new Map(model.nodes.map((n) => [n.id, { ...n }]));
    const secById = new Map(model.sections.map((s) => [s.id, s]));
    let moved = 0;

    // Auto-size every note from its content before laying out, so the arranger
    // packs boxes at their readable sizes and sections wrap them correctly.
    // CLI-only — the in-app auto-arrange leaves note sizes untouched.
    for (const n of model.nodes) {
      const size = autoSizeNote(n.content);
      n.w = size.w;
      n.h = size.h;
    }

    const next = arrangeBoard(model);

    // Sections first (larger first) so a note never momentarily lands outside the
    // section it belongs to during the per-update folder reconcile.
    const movedSections = next.sections.filter((s) => {
      const cur = secById.get(s.id);
      return cur && (cur.x !== s.x || cur.y !== s.y || cur.w !== s.w || cur.h !== s.h);
    });
    movedSections.sort(
      (a, b) => (b.w * b.h) - (a.w * a.h)
    );
    for (const s of movedSections) {
      storage.updateSection(id, s.id, { x: s.x, y: s.y, w: s.w, h: s.h });
      moved++;
    }
    // Batch every node move into one storage call (one layout write + one folder
    // reconcile) instead of reconciling the whole tree once per node.
    const nodePatches = [];
    for (const n of next.nodes) {
      const cur = nodeById.get(n.id);
      if (cur && (cur.x !== n.x || cur.y !== n.y || cur.w !== n.w || cur.h !== n.h)) {
        nodePatches.push({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h });
        moved++;
      }
    }
    if (nodePatches.length) storage.updateNodes(id, nodePatches);
    out({ ok: true, board: id, moved });
  },

  // Auto-format — tidy a board for human legibility without reflowing the
  // arrangement: snap every box to a 10px grid, then shrink/grow each section to
  // wrap the notes it owns with uniform padding. Safe to run after any edit.
  format({ positional }) {
    const id = boardIdOrFail(positional[0]);
    const model = boardModel(id);
    const snap = (v) => Math.round(v / 10) * 10;
    let changed = 0;

    const nodePatches = [];
    for (const n of model.nodes) {
      const patch = { x: snap(n.x), y: snap(n.y), w: snap(n.w), h: snap(n.h) };
      if (patch.x !== n.x || patch.y !== n.y || patch.w !== n.w || patch.h !== n.h) {
        nodePatches.push({ id: n.id, ...patch });
        Object.assign(n, patch);
        changed++;
      }
    }
    // One batched write + reconcile for all snapped notes (see arrange above).
    if (nodePatches.length) storage.updateNodes(id, nodePatches);

    // Sort sections largest-first so resizing an outer section doesn't fight a
    // nested one; recompute the wrap from the (now snapped) node positions.
    for (const s of [...model.sections].sort((a, b) => area(b) - area(a))) {
      const owned = notesOwnedBy(model, s);
      const patch = { x: snap(s.x), y: snap(s.y), w: snap(s.w), h: snap(s.h) };
      if (owned.length) {
        const right = Math.max(...owned.map((n) => n.x + n.w)) + PAD;
        const bottom = Math.max(...owned.map((n) => n.y + n.h)) + PAD;
        patch.w = Math.max(patch.w, right - patch.x);
        patch.h = Math.max(patch.h, bottom - patch.y);
      }
      if (patch.x !== s.x || patch.y !== s.y || patch.w !== s.w || patch.h !== s.h) {
        storage.updateSection(id, s.id, patch);
        Object.assign(s, patch);
        changed++;
      }
    }
    out({ ok: true, board: id, adjusted: changed });
  },
};

// Live board model (nodes carry content) used by placement/resolution helpers.
function boardModel(id) {
  const b = storage.getBoard(id);
  return { nodes: b.nodes, sections: b.sections, connections: b.connections };
}

const HELP = `brnstrm — agent CLI for reading and writing brainstorm boards

Reading
  list                                  list every board (id<TAB>name)
  read <board> [--section S|--note N]    board (or one section/note) as markdown
  comments <board> [--section S|--note N] user comments (read-only; agents can't add)
  resources <board>                     list reference files on a board
  read-resource <board> <name>          print a reference file

Boards (synthesis)
  new-board <name>                      create an empty board
  rename-board <board> <name>           rename a board
  delete-board <board>                  delete a board

Notes
  add-note <board> [--name N] [--content C|--content-file F|--content -]
           [--section S] [--x --y --w --h]
                                        add a note; --section auto-places it
  set-note <board> <node-id> [--name --content[-file] --x --y --w --h]
  rm-note  <board> <node-id>

Sections
  add-section <board> [--label L] [--x --y --w --h]
  set-section <board> <section-id> [--label --x --y --w --h]
  rm-section  <board> <section-id>

Connections (arrows)
  connect <board> --from A --to B [--label REL]   A/B = id, note name, or section
  rm-connection <board> <conn-id>

Maintenance
  arrange <board>                       arrow-aware force-directed layout (reflows)
  format  <board>                       snap to grid + wrap sections (no reflow)

<board> accepts an id, folder slug, or display name. Mutations print JSON with
the affected ids. Boards are plain files under data/ — use git to undo.
`;

/* ---------------- dispatch ---------------- */
// Run the agent CLI for a given argv tail ([command, ...args]). Exported so the
// unified `brnstrm` entry point (bin/cli.mjs) can forward agent commands here
// without re-implementing the dispatch table.
export { HELP };
export function run(argv) {
  storage.initStorage();
  const [cmd, ...rest] = argv;
  const handler = commands[cmd];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (!handler) {
    fail(`unknown command "${cmd}" — run \`help\` for the command list`);
  }
  try {
    handler(parseArgs(rest));
  } catch (err) {
    fail(String(err && err.message ? err.message : err));
  }
}

// Self-execute when invoked directly (e.g. `node bin/brnstrm.mjs read foo`),
// but stay inert when imported by the dispatcher.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run(process.argv.slice(2));
}
