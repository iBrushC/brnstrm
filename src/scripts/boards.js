// Sidebar board list: switch, create, and right-click-to-rename.

import { api } from "./api.js";

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
      li.textContent = b.name;
      li.title = "click to open · right-click to rename";
      li.addEventListener("click", () => switchTo(b.id));
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        beginRename(b, li);
      });
      listEl.appendChild(li);
    }
  }

  function switchTo(id) {
    currentId = id;
    render();
    onSwitch(id);
  }

  // Swap the list item for an inline input.
  function beginRename(b, li) {
    const input = document.createElement("input");
    input.className = "board-rename";
    input.value = b.name;
    li.replaceWith(input);
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

  async function addBoard() {
    const b = await api.createBoard("new board");
    boards.push(b);
    switchTo(b.id);
  }

  addBtn.addEventListener("click", addBoard);

  return { load, current };
}
