// In-place text editing: swap a display element for a text <input>, commit on
// blur or Enter, revert on Escape. Used for renaming nodes, sections, arrow
// labels, and boards — each supplies what "commit" means via onCommit.
//
// onCommit(value, input) receives the trimmed input value and the live input
// element, so the caller can update its display element and swap it back in
// (input.replaceWith(displayEl)) or re-render its own list.

export function inlineEdit(target, {
  value = "",
  placeholder = "",
  className,
  style,
  onCommit,
  resetValue, // value restored on Escape; defaults to the initial value
  stopProp = true, // stop mousedown/keydown from bubbling to canvas handlers
}) {
  const input = document.createElement("input");
  if (className) input.className = className;
  input.value = value;
  input.placeholder = placeholder;
  if (style) Object.assign(input.style, style);

  target.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    onCommit(input.value.trim(), input);
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (stopProp) e.stopPropagation();
    if (e.key === "Enter") {
      input.blur();
    } else if (e.key === "Escape") {
      input.value = resetValue !== undefined ? resetValue : value;
      input.blur(); // commits the restored value
    }
  });
  if (stopProp) input.addEventListener("mousedown", (e) => e.stopPropagation());

  return input;
}
