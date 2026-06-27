// Comment layer — user remarks pinned to a note or section. Each target that has
// at least one comment shows a small circular badge (the comment count) anchored
// inside its element, so the badge tracks the thing as it moves and zooms.
// Clicking a badge opens a popover listing every remark on that target and a
// composer to add another. Comments are written via the wheel's "Comment" tool:
// pick it, then click the note/section to attach to (the same node-wins-else-
// innermost-section hit test the arrow tool uses).
//
// Comments are a human affordance — created and removed only here in the browser.
// The agent CLI reads them but never writes them (see bin/brnstrm.mjs).

import { api } from "./api.js";
import { screenToWorld } from "./view.js";

export function createCommentLayer({ canvas, getBoardId, getNodeEl, getSectionEl, getSectionAt }) {
  // targetId -> { kind, entries: [{ n, author, created, text, ... }], badge }
  let targets = new Map();
  let attaching = false;
  let popover = null; // { targetId, kind, el, input, listEl }

  const targetEl = (targetId, kind) =>
    kind === "section" ? getSectionEl(targetId) : getNodeEl(targetId);

  /* ---------- badges ---------- */

  function ensureBadge(targetId, kind) {
    const t = targets.get(targetId);
    if (!t) return null;
    const host = targetEl(targetId, kind);
    if (!host) return t; // host element not present (e.g. board still loading)
    if (!t.badge || t.badge.parentElement !== host) {
      const badge = document.createElement("button");
      badge.className = "comment-badge";
      badge.addEventListener("mousedown", (e) => e.stopPropagation());
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        // Clicking an open target's badge toggles the popover shut.
        if (popover && popover.targetId === targetId) closePopover();
        else openPopover(targetId, t.kind);
      });
      host.appendChild(badge);
      t.badge = badge;
    }
    return t;
  }

  function refreshBadge(targetId) {
    const t = targets.get(targetId);
    if (!t) return;
    if (!t.entries.length) {
      if (t.badge) {
        t.badge.remove();
        t.badge = null;
      }
      return;
    }
    ensureBadge(targetId, t.kind);
    if (t.badge) {
      t.badge.textContent = String(t.entries.length);
      t.badge.title = t.entries.length === 1 ? "1 comment" : t.entries.length + " comments";
    }
  }

  /* ---------- data ---------- */

  function getTarget(targetId, kind) {
    let t = targets.get(targetId);
    if (!t) {
      t = { kind, entries: [], badge: null };
      targets.set(targetId, t);
    }
    return t;
  }

  function addEntry(entry) {
    const t = getTarget(entry.targetId, entry.targetKind);
    t.entries.push(entry);
    t.entries.sort((a, b) => a.n - b.n);
    refreshBadge(entry.targetId);
    if (popover && popover.targetId === entry.targetId) renderList();
  }

  async function removeEntry(targetId, n) {
    const t = targets.get(targetId);
    if (t) {
      t.entries = t.entries.filter((e) => e.n !== n);
      refreshBadge(targetId);
      if (popover && popover.targetId === targetId) renderList();
    }
    const id = getBoardId();
    if (id) {
      try {
        await api.deleteComment(id, targetId, n);
      } catch (err) {
        console.error(err);
      }
    }
  }

  // Replace all comments for the current board (called after each board load).
  function load(comments) {
    clear();
    for (const c of comments || []) getTarget(c.targetId, c.targetKind).entries.push(c);
    for (const [id, t] of targets) {
      t.entries.sort((a, b) => a.n - b.n);
      refreshBadge(id);
    }
  }

  function clear() {
    closePopover();
    for (const [, t] of targets) if (t.badge) t.badge.remove();
    targets = new Map();
  }

  // A note/section was deleted — drop its comments from the UI (the server has
  // already removed the files). The badge vanished with the host element.
  function removeForTarget(targetId) {
    if (popover && popover.targetId === targetId) closePopover();
    targets.delete(targetId);
  }

  /* ---------- popover ---------- */

  function shortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    );
  }

  function renderList() {
    if (!popover) return;
    const t = targets.get(popover.targetId);
    const entries = t ? t.entries : [];
    popover.listEl.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "comment-empty";
      empty.textContent = "No comments yet.";
      popover.listEl.appendChild(empty);
      return;
    }
    for (const e of entries) {
      const item = document.createElement("div");
      item.className = "comment-item";

      const meta = document.createElement("div");
      meta.className = "comment-meta";
      const who = document.createElement("span");
      who.className = "comment-author";
      who.textContent = e.author || "anonymous";
      const when = document.createElement("span");
      when.className = "comment-date";
      when.textContent = shortDate(e.created);
      const del = document.createElement("button");
      del.className = "comment-del";
      del.textContent = "×";
      del.title = "Delete comment";
      del.addEventListener("mousedown", (ev) => ev.stopPropagation());
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeEntry(e.targetId, e.n);
      });
      meta.append(who, when, del);

      const body = document.createElement("div");
      body.className = "comment-text";
      body.textContent = e.text;

      item.append(meta, body);
      popover.listEl.appendChild(item);
    }
  }

  // Post the composer's text, if any. Empty input is discarded (never written).
  async function flushComposer(targetId, kind, text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    const id = getBoardId();
    if (!id) return;
    try {
      const entry = await api.createComment(id, targetId, trimmed);
      addEntry(entry);
    } catch (err) {
      console.error(err);
    }
  }

  function onOutsideDown(e) {
    if (popover && !popover.el.contains(e.target)) closePopover();
  }

  function closePopover() {
    if (!popover) return;
    const p = popover;
    popover = null;
    document.removeEventListener("mousedown", onOutsideDown, true);
    // Auto-save a typed-but-unsent remark; an empty composer is simply discarded.
    const text = p.input ? p.input.value : "";
    p.el.remove();
    flushComposer(p.targetId, p.kind, text);
  }

  function openPopover(targetId, kind, { focusNew } = {}) {
    closePopover();
    const host = targetEl(targetId, kind);
    if (!host) return;
    getTarget(targetId, kind); // ensure the target exists in the map

    const el = document.createElement("div");
    el.className = "comment-popover";
    el.addEventListener("mousedown", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "comment-head";
    const title = document.createElement("span");
    title.textContent = "Comments";
    const close = document.createElement("button");
    close.className = "comment-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closePopover();
    });
    head.append(title, close);

    const listEl = document.createElement("div");
    listEl.className = "comment-list";

    const composer = document.createElement("div");
    composer.className = "comment-composer";
    const input = document.createElement("textarea");
    input.className = "comment-input";
    input.placeholder = "Add a comment…";
    input.rows = 2;
    const post = document.createElement("button");
    post.className = "comment-post";
    post.textContent = "Comment";
    post.addEventListener("mousedown", (e) => e.stopPropagation());
    post.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = input.value;
      input.value = "";
      flushComposer(targetId, kind, text);
      input.focus();
    });
    // Ctrl/Cmd+Enter posts without leaving the keyboard; plain Enter is a newline.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        post.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePopover();
      }
    });
    composer.append(input, post);

    el.append(head, listEl, composer);
    canvas.appendChild(el);

    popover = { targetId, kind, el, input, listEl };
    renderList();
    position(el, host);
    document.addEventListener("mousedown", onOutsideDown, true);
    if (focusNew) setTimeout(() => input.focus(), 0);
  }

  // Place the popover beside the host element, flipped/clamped to stay on-canvas.
  function position(el, host) {
    const cr = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const pw = el.offsetWidth || 260;
    const ph = el.offsetHeight || 240;
    let left = hr.right - cr.left + 12;
    if (left + pw > cr.width - 8) left = hr.left - cr.left - pw - 12; // flip to the left
    left = Math.max(8, Math.min(left, cr.width - pw - 8));
    let top = hr.top - cr.top;
    top = Math.max(8, Math.min(top, cr.height - ph - 8));
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  /* ---------- attach mode (wheel "Comment" tool) ---------- */

  function beginAttach() {
    if (attaching) return;
    attaching = true;
    document.body.classList.add("commenting");
    document.addEventListener("mousedown", onAttachDown, true);
  }

  function cancelAttach() {
    if (!attaching) return;
    attaching = false;
    document.body.classList.remove("commenting");
    document.removeEventListener("mousedown", onAttachDown, true);
  }

  function elAt(clientX, clientY, selector) {
    const el = document.elementFromPoint(clientX, clientY);
    return el ? el.closest(selector) : null;
  }

  // Resolve the press to a target (node wins; else the innermost section) and open
  // its popover ready for a new remark. A press over neither just exits the mode.
  function onAttachDown(e) {
    if (e.button !== 0) return;
    if (!e.target.closest("#canvas")) return; // sidebar etc.
    if (e.target.closest("#hud, #help-btn, #help-guide, #export-board")) return;
    e.preventDefault();
    e.stopPropagation();

    let targetId = null;
    let kind = null;
    const nodeEl = elAt(e.clientX, e.clientY, ".node");
    if (nodeEl) {
      targetId = nodeEl.dataset.id;
      kind = "node";
    } else {
      const r = canvas.getBoundingClientRect();
      const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const hit = getSectionAt(w.x, w.y);
      if (hit) {
        targetId = hit.id;
        kind = "section";
      }
    }
    cancelAttach();
    if (targetId) openPopover(targetId, kind, { focusNew: true });
  }

  return {
    load,
    clear,
    beginAttach,
    cancelAttach,
    closePopover,
    removeForTarget,
    isAttaching: () => attaching,
    isPopoverOpen: () => !!popover,
  };
}
