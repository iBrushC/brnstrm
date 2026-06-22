// Board → text formatter — the deterministic core that condenses a board (or a
// single section / note) into a coding-ready prompt. Pure functions only: no DOM,
// no clipboard, no network, so this module runs unchanged in the browser (behind
// llm-export.js) and in Node (behind bin/brnstrm.mjs, the agent CLI).
//
// Containment isn't stored anywhere — it mirrors the on-canvas geometry (the
// same rule the server uses to fold notes into section folders): a note belongs
// to the smallest section whose box fully encloses it, and a section nests in
// the smallest *larger* section that encloses it. We rebuild that forest here at
// format time so the output reflects exactly what the user laid out.

/* ---------------- geometry / containment ---------------- */
function rectInside(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);

// "Strictly contains" requires the outer box to be larger, so two sections with
// identical rects don't each claim the other as a parent (which would cycle).
const strictlyContains = (outer, inner) =>
  rectInside(outer, inner) && area(outer) > area(inner);

// Top-left reading order, with an id tiebreak so output is fully deterministic.
const byPos = (a, b) =>
  a.y - b.y || a.x - b.x || String(a.id).localeCompare(String(b.id));

// Build the section/note forest from raw geometry. Each section gains
// childSections + childNodes; anything with no containing section is a root.
function buildForest(nodes, sections) {
  const secs = sections.map((s) => ({
    ...s,
    childSections: [],
    childNodes: [],
    _parent: null,
  }));

  for (const s of secs) {
    let parent = null;
    for (const o of secs) {
      if (o === s) continue;
      if (strictlyContains(o, s) && (!parent || area(o) < area(parent))) parent = o;
    }
    s._parent = parent;
  }
  for (const s of secs) if (s._parent) s._parent.childSections.push(s);
  const rootSections = secs.filter((s) => !s._parent);

  const rootNodes = [];
  for (const n of nodes) {
    let parent = null;
    for (const o of secs) {
      if (rectInside(o, n) && (!parent || area(o) < area(parent))) parent = o;
    }
    if (parent) parent.childNodes.push(n);
    else rootNodes.push(n);
  }

  return { rootSections, rootNodes, secs };
}

// Every id reachable from a section (itself + all nested notes/sections), used
// to scope a section export's relationship list to what's inside it.
function collectIds(section, into = new Set()) {
  into.add(section.id);
  for (const n of section.childNodes) into.add(n.id);
  for (const cs of section.childSections) collectIds(cs, into);
  return into;
}

/* ---------------- naming ---------------- */
export function nodeName(n) {
  const nm = (n.name || "").trim();
  if (nm) return nm;
  // Fall back to the first non-empty content line (heading marks stripped).
  const first = (n.content || "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (first) return first.replace(/^#+\s*/, "").slice(0, 60);
  return n.id;
}

const sectionName = (s) => (s.label || "").trim() || s.id;

function makeNameOf(nodes, sections) {
  const map = new Map();
  for (const n of nodes) map.set(n.id, nodeName(n));
  for (const s of sections) map.set(s.id, sectionName(s));
  return (id) => map.get(id) || id;
}

/* ---------------- markdown rendering ---------------- */
const hashes = (level) => "#".repeat(Math.max(1, level));

// Stable ids ride along in an HTML comment: invisible in rendered markdown (so a
// human's pasted export stays clean) but machine-readable, so an agent can tell
// two same-named notes apart and address the right one on write-back.
function renderNote(n, level, lines) {
  lines.push(`${hashes(level)} Note: ${nodeName(n)} <!-- ${n.id} -->`, "");
  const body = (n.content || "").trim();
  if (body) lines.push(body, "");
}

function renderSection(s, level, lines) {
  lines.push(`${hashes(level)} Section: ${sectionName(s)} <!-- ${s.id} -->`, "");
  for (const n of s.childNodes.slice().sort(byPos)) renderNote(n, level + 1, lines);
  for (const cs of s.childSections.slice().sort(byPos)) renderSection(cs, level + 1, lines);
}

function renderRelationships(connections, includeId, nameOf, level, lines) {
  const rels = connections
    .filter((c) => includeId(c.from) && includeId(c.to))
    .sort(
      (a, b) =>
        nameOf(a.from).localeCompare(nameOf(b.from)) ||
        nameOf(a.to).localeCompare(nameOf(b.to))
    );
  if (!rels.length) return;
  lines.push(hashes(level) + " Relationships", "");
  for (const c of rels) {
    const label = (c.label || "").trim();
    const arrow = label ? `--${label}-->` : "-->";
    // Endpoint ids in a trailing comment disambiguate when names collide.
    lines.push(
      `- "${nameOf(c.from)}" ${arrow} "${nameOf(c.to)}" <!-- ${c.from} -> ${c.to} -->`
    );
  }
  lines.push("");
}

// Join, collapse runs of blank lines, and end with a single trailing newline.
const tidy = (lines) => lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

export const PREAMBLE_BOARD =
  "The following is a brainstorm exported from a visual board (brnstrm). " +
  "Sections group related notes, and arrows describe relationships between them. " +
  "Treat it as a specification of ideas to implement.";

export const PREAMBLE_SECTION =
  "The following is one section of a brainstorm exported from a visual board (brnstrm). " +
  "Nested sections group related notes, and arrows describe relationships between them. " +
  "Treat it as a specification of ideas to implement.";

export function formatBoard(boardName, { nodes, sections, connections }) {
  const nameOf = makeNameOf(nodes, sections);
  const { rootSections, rootNodes } = buildForest(nodes, sections);
  const lines = [PREAMBLE_BOARD, "", "# Board: " + (boardName || "Untitled board"), ""];
  for (const n of rootNodes.slice().sort(byPos)) renderNote(n, 2, lines);
  for (const s of rootSections.slice().sort(byPos)) renderSection(s, 2, lines);
  const allIds = new Set([
    ...nodes.map((n) => n.id),
    ...sections.map((s) => s.id),
  ]);
  renderRelationships(connections, (id) => allIds.has(id), nameOf, 2, lines);
  return tidy(lines);
}

export function formatSection(sectionId, { nodes, sections, connections }) {
  const nameOf = makeNameOf(nodes, sections);
  const { secs } = buildForest(nodes, sections);
  const target = secs.find((s) => s.id === sectionId);
  if (!target) return "";
  const ids = collectIds(target);
  const lines = [PREAMBLE_SECTION, ""];
  renderSection(target, 1, lines);
  renderRelationships(connections, (id) => ids.has(id), nameOf, 2, lines);
  return tidy(lines);
}

// A note is, per spec, basically just its content. Keep the name as a heading
// when there is one (it's useful framing); otherwise emit the bare content.
export function formatNote(node) {
  const body = (node.content || "").trim();
  const nm = (node.name || "").trim();
  if (nm && body) return `# ${nm}\n\n${body}\n`;
  if (body) return body + "\n";
  return `# ${nm || node.id}\n`;
}
