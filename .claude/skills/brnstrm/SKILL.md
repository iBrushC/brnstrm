---
name: brnstrm
description: Read and write brnstrm brainstorm boards — the visual idea boards under this project's data/ folder. Use when asked to review, summarize, give feedback on, or implement from a board; to turn a plan/summary into a board; or to add notes, sections, or arrows to one. Boards are the shared human↔agent knowledge base for this project.
---

# Working with brnstrm boards

`brnstrm` is a visual brainstorming tool. A **board** holds **notes** (free-text
cards), **sections** (boxes that group notes), and **connections** (labeled
arrows describing relationships). Boards live as plain files under `data/` and
are git-tracked, so they double as a project-wide, multimodal knowledge base you
share with the human.

Everything you need is one CLI — no server required:

```
node bin/brnstrm.mjs <command> [args]
```

Run `node bin/brnstrm.mjs help` for the exact command list. `<board>` accepts a
board id, its folder slug, or its display name.

## The loop: read → reason → write

1. **See what's there.** `list`, then `read <board>` for the whole board (or
   `--section S` / `--note N` for one piece). The output is the same markdown a
   human gets from the in-app "export to LLM" button: sections become headings,
   notes become text, arrows become a Relationships list. Read before you write.
   Each note/section heading and every relationship carries its **stable id** in a
   trailing HTML comment (`### Note: API <!-- node-3 -->`,
   `- "API" --drives--> "Goals" <!-- node-3 -> section-1 -->`). When you write
   back, address things by that id rather than by name — names can repeat, ids
   never do, so the id is what guarantees you edit/connect the thing you meant.
2. **Reason** about it as a specification of ideas — that's what it is.
3. **Write back** only what the human asked for. Prefer a few well-named notes
   over many tiny ones. Name every note and section you create.

## Reading

```
node bin/brnstrm.mjs list                          # id<TAB>name for every board
node bin/brnstrm.mjs read "Implementing Skills"     # whole board → markdown
node bin/brnstrm.mjs read my-board --section Skills  # just one section
node bin/brnstrm.mjs comments my-board              # the human's comments on this board
node bin/brnstrm.mjs resources my-board             # attached reference files
node bin/brnstrm.mjs read-resource my-board spec.md  # print one reference file
```

**Comments** are short remarks the human pins to a note or section (a circle
badge in the app). They also appear inline under each note/section in `read`
output, under a `## Comments` heading. Treat them as the human's feedback on the
plan — read them when revising. Comments are **user-only**: there is no command
to add or remove them, by design. Don't try to write them; surface what they say
and act on it.

## Writing

Note bodies are **markdown** — they render with live formatting in the app, so
use it whenever it helps the content: headings, **bold**/_italic_, bullet and
numbered lists, `inline code` and fenced code blocks, links, and `> quotes`.
Reach for structure (a short heading + a few bullets) over a wall of prose.

Add a note straight into a section — geometry is computed for you, so you never
deal with pixel coordinates. Pass long markdown bodies via a file or stdin:

```
node bin/brnstrm.mjs add-section my-board --label "Backend"
node bin/brnstrm.mjs add-note my-board --name "API" --section "Backend" \
  --content "REST endpoints over the storage layer"
# pipe a body on stdin with --content - (use printf, not echo: echo leaves the
# literal "\n" in the note instead of real newlines)
printf '## Schema\n\nUsers, boards, nodes.' | \
  node bin/brnstrm.mjs add-note my-board --name "DB" --section "Backend" --content -
# for longer bodies, --content-file <path> is the most robust
node bin/brnstrm.mjs add-note my-board --name "DB" --section "Backend" --content-file schema.md
```

Connect two things by **name or id** — `connect` resolves notes and sections for
you. The `--label` is the relationship the arrow describes:

```
node bin/brnstrm.mjs connect my-board --from "Goals" --to "API" --label "drives"
```

Edit or remove with `set-note` / `set-section` / `rm-note` / `rm-section` /
`rm-connection`. Every mutating command prints the affected ids as JSON — keep
them so you can reverse a change with the matching `rm-*` / `set-*`.

## Synthesis — build a board from scratch

When asked to turn a plan or summary into a board:

```
node bin/brnstrm.mjs new-board "Migration Plan"
# add a section per phase, a note per step, arrows for dependencies, then:
node bin/brnstrm.mjs arrange migration-plan
```

Two tidy commands, for different situations:

- **`arrange <board>`** — arrow-aware force-directed layout. Connected notes are
  pulled together, notes stay inside their section, and sections are positioned
  by the arrows between them. Use this after building a board from scratch, or
  whenever the arrows are the real structure and positions are arbitrary. It
  *moves things* — that's the point.
- **`format <board>`** — snaps to a grid and wraps each section around its notes
  without reflowing. Use when the human has already arranged things and you only
  want to neaten spacing.

Both are reversible: `git diff data/` shows exactly what moved.

## Rules of thumb

- **Read before writing.** Don't duplicate a note that already exists.
- **Always name notes and sections.** Names are how arrows and humans refer to
  them; an unnamed note is hard to connect and reads poorly.
- **Edits are reversible two ways:** the printed ids (undo with `rm-*`/`set-*`)
  and git (`git diff data/` shows exactly what you changed). When you make a
  substantial change, tell the human it's a `git`-visible edit they can revert.
- **Place notes in sections** rather than loose, so they group correctly both on
  the canvas and in the exported markdown.
- Tidy as the last step of a multi-note edit: `arrange <board>` when arrows
  carry the structure, `format <board>` when you're only neatening spacing.
