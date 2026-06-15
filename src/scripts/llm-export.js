// LLM export — copies a board (or a single section / note) to the clipboard as a
// coding-ready prompt and toasts the user. The deterministic formatting lives in
// board-format.mjs (shared with the agent CLI, bin/brnstrm.mjs); this module is
// just the browser glue: live-data getters, clipboard, and the toast.

import { toast } from "./toast.js";
import { formatBoard, formatSection, formatNote } from "./board-format.mjs";

/* ---------------- clipboard ---------------- */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (_) {
    // fall through to the legacy path (e.g. clipboard blocked / insecure ctx)
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (_) {}
  ta.remove();
}

/* ---------------- public factory ---------------- */
// Pulls live board data through the supplied getters at export time, so exports
// always reflect the current canvas (including unsaved edits held in memory).
export function createExporter({ getNodes, getSections, getConnections, getBoardName }) {
  const model = () => ({
    nodes: getNodes() || [],
    sections: getSections() || [],
    connections: getConnections() || [],
  });

  async function copy(text) {
    if (!text) return;
    await copyText(text);
    toast("This idea has been copied to your clipboard");
  }

  return {
    exportBoard: () =>
      copy(formatBoard(getBoardName ? getBoardName() : "", model())),
    exportSection: (section) => copy(formatSection(section.id, model())),
    exportNote: (node) => copy(formatNote(node)),
  };
}
