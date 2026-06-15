// Generic undo stack. Each entry is a "command": { label, undo() }.
//
// Kept deliberately small and action-agnostic: every undoable action (delete,
// move, resize, paste, …) builds a command whose undo() reverses it, pushes it,
// and Ctrl+Z handles the rest. A whole gesture that touches several things (e.g.
// dragging a group of nodes and sections at once) is recorded as one command so
// a single undo reverses the lot. Redo is intentionally left out for now; add a
// parallel redo stack here when it's needed.

export function createHistory(limit = 200) {
  let stack = [];

  // command: { label: string, undo: () => void | Promise<void> }
  function push(command) {
    stack.push(command);
    if (stack.length > limit) stack.shift();
  }

  async function undo() {
    const cmd = stack.pop();
    if (!cmd) return false;
    try {
      await cmd.undo();
    } catch (err) {
      console.error("undo failed:", err);
    }
    return true;
  }

  function clear() {
    stack = [];
  }

  return {
    push,
    undo,
    clear,
    get size() {
      return stack.length;
    },
  };
}
