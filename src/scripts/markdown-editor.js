// A small live-preview markdown editor for node bodies.
//
// Unlike a rendered-then-hidden markdown view, the effect markers themselves
// stay in the text — they're just dimmed (see `.md-mark` in styles.css). So
// `**bold**` shows a bold "bold" flanked by faint `**`, and the caret moves
// through the literal characters exactly as in a plain textarea. This keeps the
// source and the cursor model identical to plain text, which is what makes the
// approach robust.
//
// How it works: the editor is a contenteditable whose source of truth is a
// plain markdown string. On every input we (1) read the string + caret back out
// of the DOM, (2) re-render the DOM from that string with styled spans, and
// (3) restore the caret by character offset. Because each logical line is one
// top-level <div>, reading and caret math stay simple and predictable.
//
// Supported: H1–H4, bold/italic, blockquotes, bullet/numbered lists, links,
// fenced code blocks (no highlighting), inline code, inline images (the markers
// stay dimmed and an image preview is rendered alongside), and `@[file]`
// resource references — typing `@` opens a picker of the board's uploaded
// files; the chosen file renders as an image preview (for images) or a small
// clickable chip showing the file's name and type (for everything else). An
// `@[photo.png]` image ref and a markdown `![](photo.png)` are interchangeable:
// both resolve the bare name to the served resource URL and render the image.

const BLOCK_TAGS = /^(DIV|P|LI|BLOCKQUOTE|H[1-6]|UL|OL|PRE)$/;

// Inline tokens, tried left-to-right at each position. Order matters: image
// before link (image starts with "!"), bold before italic (so "**" wins). The
// `@[name]` resource ref (group 7) only matches at a "@", so it can't collide.
const INLINE =
  /(!\[[^\]]*\]\([^)]*\))|(\[[^\]]*\]\([^)]*\))|(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(@\[[^\]\n]+\])/g;

// Extensions rendered as an inline image preview (everything else is a chip).
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
function isImageName(name) {
  return IMAGE_EXT.test(String(name || ""));
}

// Emoji icon for a file chip, keyed by extension.
function fileIcon(ext) {
  const e = String(ext || "").toLowerCase();
  if (/^(pdf)$/.test(e)) return "📕";
  if (/^(doc|docx|rtf|odt)$/.test(e)) return "📝";
  if (/^(xls|xlsx|csv|ods)$/.test(e)) return "📊";
  if (/^(ppt|pptx|odp)$/.test(e)) return "📑";
  if (/^(zip|rar|7z|tar|gz)$/.test(e)) return "🗜️";
  if (/^(mp4|mov|webm|mkv|avi)$/.test(e)) return "🎬";
  if (/^(mp3|wav|ogg|flac|m4a)$/.test(e)) return "🎵";
  if (/^(txt|md|json|log)$/.test(e)) return "📄";
  return "📎";
}

// The resolver turning a bare resource name into a fetchable URL. Set at the top
// of every renderInto() call (rendering is synchronous, so a single shared slot
// is safe even with multiple editor instances on the page).
let activeResolve = (name) => name;

// Options:
//   getResources()        -> Promise<[{ name, size }]>  files to offer after "@"
//   resolveResourceUrl(n) -> string                     bare name -> fetch URL
export function createMarkdownEditor({
  value = "",
  onInput,
  getResources,
  resolveResourceUrl,
} = {}) {
  const editor = document.createElement("div");
  editor.className = "node-text node-md";
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.setAttribute("data-placeholder", "…");

  const toolbar = document.createElement("div");
  toolbar.className = "node-md-toolbar";
  const linkBtn = toolbarButton("🔗", "Insert link");
  const imgBtn = toolbarButton("🖼", "Insert inline image");
  toolbar.append(linkBtn, imgBtn);

  const resolveUrl =
    typeof resolveResourceUrl === "function" ? resolveResourceUrl : (n) => n;

  let currentValue = value;
  let composing = false; // suppress re-render mid-IME-composition

  // Render through here (not renderInto directly) so this editor's resource
  // resolver is installed before the synchronous render reads it.
  function render(v) {
    activeResolve = resolveUrl;
    renderInto(editor, v);
  }

  /* ---- public surface ---- */
  function setValue(v) {
    currentValue = v;
    render(v);
  }
  function getValue() {
    return currentValue;
  }

  /* ---- typing ---- */
  // After any edit, re-derive the markdown string + caret from the DOM, then
  // re-render and restore the caret so the styling tracks the text live.
  function handleInput() {
    const { value: v, caret } = analyze(editor);
    currentValue = v;
    const scroll = editor.scrollTop;
    render(v);
    editor.scrollTop = scroll;
    placeCaret(editor, v, caret);
    if (onInput) onInput(v);
    updateMention(v, caret);
  }

  /* ---- "@" resource picker ---- */
  // Typing "@foo" (no brackets yet) opens a dropdown of matching board files;
  // choosing one replaces the "@foo" query with a "@[name]" token. The menu
  // lives on document.body so the node's overflow can't clip it.
  let mentionMenu = null; // DOM element while open, else null
  let mentionItems = []; // filtered [{ name, size }]
  let mentionActive = 0; // highlighted row index
  let mentionStart = -1; // caret index of the triggering "@"
  let resourceCache = null; // file list for the current open session

  // A trailing "@" + query (anything but newline, another "@", brackets, or a
  // path separator — those mean it isn't a bare reference being typed).
  const MENTION_RE = /@([^\n@[\]\\/]*)$/;

  async function ensureResources() {
    if (resourceCache) return resourceCache;
    try {
      resourceCache = (getResources ? await getResources() : []) || [];
    } catch (_) {
      resourceCache = [];
    }
    return resourceCache;
  }

  async function updateMention(value, caret) {
    const m = MENTION_RE.exec(value.slice(0, caret));
    if (!m) return closeMention();
    mentionStart = caret - m[0].length;
    const query = m[1].toLowerCase();
    const all = await ensureResources();
    mentionItems = all
      .filter((r) => r.name.toLowerCase().includes(query))
      .slice(0, 8);
    if (!mentionItems.length) return closeMention();
    if (mentionActive >= mentionItems.length) mentionActive = 0;
    openMention();
  }

  function openMention() {
    if (!mentionMenu) {
      mentionMenu = document.createElement("div");
      mentionMenu.className = "mention-menu";
      document.body.appendChild(mentionMenu);
    }
    mentionMenu.innerHTML = "";
    mentionItems.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "mention-item" + (i === mentionActive ? " active" : "");
      const ext = (it.name.split(".").pop() || "").toLowerCase();
      const ic = span("mention-icon", fileIcon(ext));
      const nm = span("mention-name", it.name);
      row.append(ic, nm);
      // mousedown (not click) + preventDefault keeps the editor focused so the
      // caret/selection survive to the insertion.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        chooseMention(i);
      });
      mentionMenu.appendChild(row);
    });
    const rect = caretRect(editor);
    if (rect) {
      mentionMenu.style.left = Math.round(rect.left) + "px";
      mentionMenu.style.top = Math.round(rect.bottom + 4) + "px";
    }
  }

  function closeMention() {
    if (mentionMenu) {
      mentionMenu.remove();
      mentionMenu = null;
    }
    mentionItems = [];
    mentionActive = 0;
    mentionStart = -1;
    resourceCache = null; // refetch next session so new uploads show up
  }

  function chooseMention(i) {
    const it = mentionItems[i];
    if (!it) return;
    const { value: v, caret } = analyze(editor);
    const start = mentionStart >= 0 ? mentionStart : caret;
    const token = "@[" + it.name + "]";
    const nv = v.slice(0, start) + token + v.slice(caret);
    currentValue = nv;
    render(nv);
    editor.focus();
    placeCaret(editor, nv, start + token.length);
    closeMention();
    if (onInput) onInput(nv);
  }

  // While the menu is open, the arrow/enter/escape keys drive it instead of the
  // editor. preventDefault on keydown suppresses the default text action (e.g.
  // Enter inserting a newline) before it happens.
  editor.addEventListener("keydown", (e) => {
    if (!mentionMenu) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mentionActive = (mentionActive + 1) % mentionItems.length;
      openMention();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      mentionActive =
        (mentionActive - 1 + mentionItems.length) % mentionItems.length;
      openMention();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseMention(mentionActive);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMention();
    }
  });

  // Leaving the editor dismisses the menu (a menu-row mousedown preventDefault
  // keeps focus, so picking a file doesn't trip this).
  editor.addEventListener("blur", () => closeMention());

  editor.addEventListener("input", () => {
    if (!composing) handleInput();
  });
  editor.addEventListener("compositionstart", () => (composing = true));
  editor.addEventListener("compositionend", () => {
    composing = false;
    handleInput();
  });

  // Keep paste plain-text — the live preview only understands markdown source,
  // not arbitrary pasted HTML.
  editor.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    spliceSelection(text, text.length);
  });

  /* ---- toolbar: link / image insertion ---- */
  // mousedown + preventDefault so the editor keeps focus and its selection
  // (the buttons never steal the caret); stopPropagation so the press doesn't
  // reach the node/canvas drag handlers.
  linkBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    insertWrap("[", "](url)", "text", 1);
  });
  imgBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    insertWrap("![", "](url)", "alt", 1);
  });

  // Insert `${open}${label}${close}` over the current selection (selection text
  // becomes the label), then select the "url" placeholder inside `close` so the
  // user can immediately type the destination.
  function insertWrap(open, close, placeholder, urlLenInClose) {
    const { value: v, start, end } = analyze(editor);
    const label = v.slice(start, end) || placeholder;
    const snippet = open + label + close;
    const nv = v.slice(0, start) + snippet + v.slice(end);
    currentValue = nv;
    render(nv);
    editor.focus();
    // "url" sits between the "(" and ")" of `close`.
    const urlStart = start + open.length + label.length + 2; // past "("
    const urlEnd = nv.indexOf(")", urlStart);
    setSelection(editor, nv, urlStart, urlEnd === -1 ? nv.length : urlEnd);
    if (onInput) onInput(nv);
  }

  // Replace the current selection with `text` and drop the caret `caretInText`
  // chars into it. Used for paste.
  function spliceSelection(text, caretInText) {
    const { value: v, start, end } = analyze(editor);
    const nv = v.slice(0, start) + text + v.slice(end);
    currentValue = nv;
    render(nv);
    editor.focus();
    placeCaret(editor, nv, start + caretInText);
    if (onInput) onInput(nv);
  }

  setValue(value);

  return {
    editor,
    toolbar,
    focus: () => editor.focus(),
    getValue,
    setValue,
  };
}

/* ============================ rendering ============================ */

function renderInto(editor, value) {
  editor.innerHTML = "";
  editor.classList.toggle("is-empty", value.length === 0);

  const lines = value.split("\n");
  let inCode = false; // inside a ``` fenced block

  for (const text of lines) {
    const div = document.createElement("div");
    div.className = "md-line";

    const fence = /^\s*```/.test(text);
    if (fence) {
      div.classList.add("md-code", "md-code-fence");
      div.appendChild(markSpan(text));
      inCode = !inCode;
    } else if (inCode) {
      div.classList.add("md-code");
      appendLineText(div, text); // raw, no inline parsing inside code
    } else {
      renderBlockLine(div, text);
    }

    editor.appendChild(div);
  }
}

// A single non-code line: detect a block prefix (heading / quote / list),
// render that prefix as a dimmed marker, then inline-parse the remainder.
function renderBlockLine(div, text) {
  if (text === "") {
    div.appendChild(document.createElement("br"));
    return;
  }

  let m;
  if ((m = /^(#{1,4})(\s+)(.*)$/.exec(text))) {
    div.classList.add("md-h" + m[1].length);
    div.appendChild(markSpan(m[1] + m[2]));
    renderInline(div, m[3]);
  } else if ((m = /^(\s*>+\s?)(.*)$/.exec(text))) {
    div.classList.add("md-quote");
    div.appendChild(markSpan(m[1]));
    renderInline(div, m[2]);
  } else if ((m = /^(\s*\d+\.\s+)(.*)$/.exec(text))) {
    div.classList.add("md-li");
    div.appendChild(markSpan(m[1]));
    renderInline(div, m[2]);
  } else if ((m = /^(\s*[-*+]\s+)(.*)$/.exec(text))) {
    div.classList.add("md-li");
    div.appendChild(markSpan(m[1]));
    renderInline(div, m[2]);
  } else {
    renderInline(div, text);
  }
}

// Walk a text segment emitting plain text for the gaps and styled span groups
// for each inline token. Every marker character is preserved as a `.md-mark`
// span so the source string is unchanged — only the opacity differs.
function renderInline(parent, text) {
  INLINE.lastIndex = 0;
  let pos = 0;
  let m;
  while ((m = INLINE.exec(text))) {
    if (m.index > pos) appendLineText(parent, text.slice(pos, m.index));

    if (m[1]) emitImage(parent, m[1]);
    else if (m[2]) emitLink(parent, m[2]);
    else if (m[3]) emitWrapped(parent, m[3], 1, "md-inline-code");
    else if (m[4]) emitWrapped(parent, m[4], 2, "md-bold");
    else if (m[5]) emitWrapped(parent, m[5], 1, "md-italic");
    else if (m[6]) emitWrapped(parent, m[6], 1, "md-italic");
    else if (m[7]) emitFileRef(parent, m[7]);

    pos = INLINE.lastIndex;
  }
  if (pos < text.length) appendLineText(parent, text.slice(pos));
}

// `**x**`, `*x*`, `` `x` `` → dim the `n`-char fences, style the content.
function emitWrapped(parent, token, markLen, cls) {
  const inner = token.slice(markLen, token.length - markLen);
  parent.append(
    markSpan(token.slice(0, markLen)),
    span(cls, inner),
    markSpan(token.slice(token.length - markLen))
  );
}

// `[text](url)` → dim `[` and `](url)`, style the link text.
function emitLink(parent, token) {
  const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token);
  parent.append(
    markSpan("["),
    span("md-link", m[1]),
    markSpan("](" + m[2] + ")")
  );
}

// `![alt](url)` → dim the markers (kept verbatim) and render a live preview.
// A bare url (no scheme and no leading "/") is treated as a resource name and
// resolved to its served URL, so `![](photo.png)` and `@[photo.png]` render the
// same image.
function emitImage(parent, token) {
  const m = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(token);
  const alt = m[1];
  const url = m[2];
  parent.append(
    markSpan("!["),
    span(null, alt),
    markSpan("](" + url + ")")
  );
  if (url) parent.appendChild(imagePreview(resolveMaybeResource(url), alt));
}

// `@[name]` → dim the markers (the literal source) and render a preview: an
// image for image files, otherwise a clickable chip naming the file + its type.
function emitFileRef(parent, token) {
  const name = token.slice(2, -1); // strip "@[" … "]"
  parent.append(markSpan("@["), span(null, name), markSpan("]"));
  const url = activeResolve(name);
  if (isImageName(name)) parent.appendChild(imagePreview(url, name));
  else parent.appendChild(fileChip(name, url));
}

// A url is a resource name when it carries no scheme ("http:", "data:") and is
// not an absolute path ("/…"); those resolve through the active resolver.
function resolveMaybeResource(url) {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) return url;
  return activeResolve(url);
}

// Shared <img> preview for image refs (markdown or "@"). Clicking opens the
// full file in a new tab; broken sources collapse (.md-img-broken).
function imagePreview(url, alt) {
  const img = document.createElement("img");
  img.className = "md-img";
  img.src = url;
  img.alt = alt;
  img.contentEditable = "false";
  img.draggable = false;
  img.addEventListener("error", () => img.classList.add("md-img-broken"));
  img.addEventListener("mousedown", (e) => e.preventDefault());
  img.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (url) window.open(url, "_blank");
  });
  return img;
}

// Inline chip for a non-image resource: icon + name + type tag. Excluded from
// the serialized markdown (data-skip) since the "@[name]" markers already carry
// the source text. Clicking opens the file in a new tab.
function fileChip(name, url) {
  const chip = document.createElement("span");
  chip.className = "md-file-chip";
  chip.contentEditable = "false";
  chip.dataset.skip = "";
  chip.title = name;
  const ext = (name.split(".").pop() || "").toLowerCase();
  chip.append(
    span("md-file-icon", fileIcon(ext)),
    span("md-file-name", name),
    span("md-file-type", ext ? ext.toUpperCase() : "FILE")
  );
  chip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (url) window.open(url, "_blank");
  });
  return chip;
}

// Screen rect of the current caret, used to anchor the "@" picker. A collapsed
// range still reports a usable top/left in Chromium (the app's runtime).
function caretRect(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height && !rect.left && !rect.top)) {
    return root.getBoundingClientRect();
  }
  return rect;
}

function span(cls, text) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function markSpan(text) {
  return span("md-mark", text);
}

// Preview-only nodes carry no markdown source text and are skipped by the
// serializers: inline image previews (<img>) and file chips (data-skip).
function isPreview(node) {
  return (
    node.nodeName === "IMG" ||
    (node.nodeType === 1 && node.dataset && "skip" in node.dataset)
  );
}

// Append plain text; an empty line still needs a <br> to hold its height.
function appendLineText(parent, text) {
  if (text === "") parent.appendChild(document.createElement("br"));
  else parent.appendChild(document.createTextNode(text));
}

/* ===================== reading text + caret back ===================== */

// Serialize the contenteditable back to a markdown string. Each block element
// boundary and each <br> is one "\n"; images contribute nothing. The single
// trailing newline added by closing the last block is stripped — genuinely
// empty trailing lines carry their own <br>, so they survive.
function readValue(root) {
  let out = "";
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue;
      } else if (child.nodeName === "BR") {
        out += "\n";
      } else if (isPreview(child)) {
        // preview-only (image / file chip) — contributes no source text
      } else {
        const block = BLOCK_TAGS.test(child.nodeName);
        if (block && out.length && !out.endsWith("\n")) out += "\n";
        walk(child);
        if (block && !out.endsWith("\n")) out += "\n";
      }
    }
  })(root);
  if (out.endsWith("\n")) out = out.slice(0, -1);
  return out;
}

// Character offset of (node, offset) within the serialized string, using the
// exact same accounting as readValue so the index lines up with the value.
function indexInValue(root, node, offset) {
  let out = "";
  let found = null;
  (function walk(parent) {
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length && found === null; i++) {
      if (node === parent && offset === i) {
        found = out.length;
        return;
      }
      const child = kids[i];
      if (child.nodeType === Node.TEXT_NODE) {
        if (node === child) found = out.length + Math.min(offset, child.nodeValue.length);
        out += child.nodeValue;
      } else if (child.nodeName === "BR") {
        out += "\n";
      } else if (isPreview(child)) {
        // preview-only (image / file chip) — contributes no source text
      } else {
        const block = BLOCK_TAGS.test(child.nodeName);
        if (block && out.length && !out.endsWith("\n")) out += "\n";
        walk(child);
        if (block && found === null && !out.endsWith("\n")) out += "\n";
      }
    }
    if (found === null && node === parent && offset === kids.length) found = out.length;
  })(root);
  return found;
}

// Current markdown string plus selection, as character offsets into it.
function analyze(root) {
  const value = readValue(root);
  const sel = window.getSelection();
  let caret = value.length;
  let start = value.length;
  let end = value.length;

  if (sel && sel.rangeCount && root.contains(sel.anchorNode)) {
    const a = indexInValue(root, sel.anchorNode, sel.anchorOffset);
    const f = indexInValue(root, sel.focusNode, sel.focusOffset);
    if (a !== null && f !== null) {
      const clamp = (n) => Math.max(0, Math.min(n, value.length));
      caret = clamp(f);
      start = clamp(Math.min(a, f));
      end = clamp(Math.max(a, f));
    }
  }
  return { value, caret, start, end };
}

/* ===================== restoring the caret ===================== */

// Map a character offset in `value` to a concrete (node, offset) DOM point.
// The freshly rendered DOM has exactly one top-level line <div> per value line,
// so we locate the line, then walk that line's text nodes for the column.
function pointFor(root, value, index) {
  index = Math.max(0, Math.min(index, value.length));
  const lines = value.split("\n");

  let li = 0;
  let col = index;
  while (li < lines.length && col > lines[li].length) {
    col -= lines[li].length + 1; // +1 for the newline between lines
    li++;
  }
  if (li >= root.children.length) {
    li = root.children.length - 1;
    col = (lines[li] || "").length;
  }
  const lineEl = root.children[li];
  if (!lineEl) return { node: root, offset: 0 };

  const tw = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let last = null;
  let n;
  while ((n = tw.nextNode())) {
    last = n;
    const len = n.nodeValue.length;
    if (col <= acc + len) return { node: n, offset: col - acc };
    acc += len;
  }
  if (last) return { node: last, offset: last.nodeValue.length };
  return { node: lineEl, offset: 0 }; // empty line (only a <br>)
}

function placeCaret(root, value, index) {
  const p = pointFor(root, value, index);
  const range = document.createRange();
  range.setStart(p.node, p.offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function setSelection(root, value, from, to) {
  const a = pointFor(root, value, from);
  const b = pointFor(root, value, to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ===================== toolbar button factory ===================== */

function toolbarButton(label, title) {
  const b = document.createElement("button");
  b.className = "node-md-btn";
  b.type = "button";
  b.textContent = label;
  b.title = title;
  return b;
}
