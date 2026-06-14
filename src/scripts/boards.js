// Sidebar board list: switch, create, right-click-to-rename, and × to delete (with undo toast).

import { api } from "./api.js";

let toastEl = null;
let toastTimer = null;

function showToast(message, onUndo) {
  if (toastEl) {
    clearTimeout(toastTimer);
    toastEl.remove();
    toastEl = null;
  }
  toastEl = document.createElement("div");
  toastEl.className = "toast";
  const msg = document.createElement("span");
  msg.textContent = message;
  const undoBtn = document.createElement("button");
  undoBtn.className = "toast-undo";
  undoBtn.textContent = "Undo";
  undoBtn.addEventListener("click", () => {
    clearTimeout(toastTimer);
    toastEl.remove();
    toastEl = null;
    onUndo();
  });
  toastEl.append(msg, undoBtn);
  document.body.appendChild(toastEl);
  toastTimer = setTimeout(() => {
    if (toastEl) { toastEl.remove(); toastEl = null; }
  }, 5000);
}

export function createBoardBar({ listEl, addBtn, onSwitch }) {
  let boards = [];
  let currentId = null;

  const current = () => currentId;

  async function load() {
    boards = await api.listBoards();
    if (boards.length === 0) {
      boards = [await api.createBoard("untitled board")];
    }
    switchTo(boards[0].id);
  }

  function render() {
    listEl.innerHTML = "";
    for (const b of boards) {
      const li = document.createElement("li");
      li.className = "board" + (b.id === currentId ? " active" : "");
      li.title = "click to open · right-click to rename";

      const nameSpan = document.createElement("span");
      nameSpan.className = "board-name";
      nameSpan.textContent = b.name;

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "board-delete";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Delete board";
      deleteBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteBoard(b);
      });

      li.append(nameSpan, deleteBtn);
      li.addEventListener("click", (e) => {
        if (!e.target.closest(".board-delete")) switchTo(b.id);
      });
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        beginRename(b, nameSpan);
      });
      listEl.appendChild(li);
    }
  }

  function switchTo(id) {
    currentId = id;
    render();
    onSwitch(id);
  }

  // Swap the name span for an inline input.
  function beginRename(b, nameSpan) {
    const input = document.createElement("input");
    input.className = "board-rename";
    input.value = b.name;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const name = input.value.trim() || b.name;
      try {
        const updated = await api.renameBoard(b.id, name);
        b.name = updated.name;
      } catch (err) {
        console.error(err);
      }
      render();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") {
        input.value = b.name;
        input.blur();
      }
    });
  }

  async function deleteBoard(b) {
    // Snapshot full board data before deleting so undo can recreate it.
    let snapshot = null;
    try {
      snapshot = await api.getBoard(b.id);
    } catch (err) {
      console.error("Could not snapshot board for undo:", err);
    }

    const wasActive = b.id === currentId;
    boards = boards.filter((board) => board.id !== b.id);

    try {
      await api.deleteBoard(b.id);
    } catch (err) {
      console.error(err);
      boards.push(b);
      render();
      return;
    }

    if (wasActive) {
      if (boards.length === 0) {
        const newBoard = await api.createBoard("untitled board");
        boards.push(newBoard);
      }
      switchTo(boards[0].id);
    } else {
      render();
    }

    if (!snapshot) return;

    showToast(`"${b.name}" deleted`, async () => {
      try {
        const newBoard = await api.createBoard(snapshot.name);
        for (const node of snapshot.nodes || []) {
          await api.createNode(newBoard.id, node);
        }
        for (const section of snapshot.sections || []) {
          await api.createSection(newBoard.id, section);
        }
        for (const conn of snapshot.connections || []) {
          await api.createConnection(newBoard.id, conn);
        }
        boards.push(newBoard);
        switchTo(newBoard.id);
      } catch (err) {
        console.error("Board restore failed:", err);
      }
    });
  }

  async function addBoard() {
    const b = await api.createBoard("new board");
    boards.push(b);
    switchTo(b.id);
  }

  addBtn.addEventListener("click", addBoard);

  return { load, current };
}
