// Generic undo stack. Each entry is a "command": { label, undo() }.
//
// Kept deliberately small and action-agnostic so new undoable actions (move,
// resize, create, …) can be recorded the same way later — build a command with
// an undo() that reverses the action, push it, and Ctrl+Z handles the rest.
// Redo is intentionally left out for now; add a parallel redo stack here when
// it's needed.

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
