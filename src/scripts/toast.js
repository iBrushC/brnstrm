// A small bottom-of-screen toast. Pass a plain message, or an `onUndo` callback
// to add an Undo button. Only one toast shows at a time — a new one replaces the
// old, so rapid actions (a file drop right after a board delete) don't stack.

let current = null;
let timer = null;

function dismiss() {
  clearTimeout(timer);
  if (current) {
    current.remove();
    current = null;
  }
}

// toast("Saved")                         — auto-dismisses after `duration`
// toast("Deleted", { onUndo })           — adds an Undo button
export function toast(message, { onUndo, duration } = {}) {
  dismiss();

  const el = document.createElement("div");
  el.className = "toast";
  const msg = document.createElement("span");
  msg.textContent = message;
  el.appendChild(msg);

  if (onUndo) {
    const undoBtn = document.createElement("button");
    undoBtn.className = "toast-undo";
    undoBtn.textContent = "Undo";
    undoBtn.addEventListener("click", () => {
      dismiss();
      onUndo();
    });
    el.appendChild(undoBtn);
  }

  current = el;
  document.body.appendChild(el);
  timer = setTimeout(dismiss, duration || (onUndo ? 5000 : 4000));
}
