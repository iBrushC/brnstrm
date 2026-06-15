# 🧠 brnstrm 🌪️
We don't think in just text, why should we be restricted when making code? `brnstrm` is a simple workspace for brainstorming, planning, and managing implementation details for complex projects. Manage ideas, build diagrams, include references, and more, then hand off to your coding agent of choice to handle the implementation.

## Usage
Set `brnstrm` up in any project — Node or not — with one command:

```
npx brnstrm init
```

This interactive setup:
- creates a `.brnstrm/` folder where this project's boards live,
- asks whether to track your boards in git (and edits `.gitignore` to match),
- installs the brnstrm skill for the coding agent(s) you use (Claude Code,
  Cursor, or a generic `AGENTS.md`), so they can read and write your boards.

It only touches those things — nothing else. For scripts/CI it's also
non-interactive: `npx brnstrm init --yes --no-git --agents=claude,cursor`.

Then start the visual workspace:

```
npx brnstrm
```

It serves the workspace at `localhost:8888`, backed by the `.brnstrm/` folder
in your project.

## How It Works
Each project has a set of *boards*, which manage ideas relating to your project. Within each board, *cards* represent ideas. Each card is a free-form text editor which allows you to enter the following data types:
- Text (markdown)
- Images
- Graphs/Flow Charts
- Documents
- Freeform Drawings

These cards let you express ideas more effectively. These can be used in a multitude of ways, including but not limited to:
1. Outlining ideas then handing them off to agents
2. Having agents create plans our summarize systems with cards
3. Giving other team members and agents a consistent multimodal knowledge base of the project

## Agentic Brainstorming
Coding agents can read and write boards directly through a headless CLI — no
browser or running server needed. This lets you brainstorm with an agent: lay
out a system, have the agent review it, expand it into well-defined chunks, or
turn a plan it wrote into a board you can see.

```
npx brnstrm help                       # full command list
npx brnstrm list                        # list boards
npx brnstrm read <board>                # board → agent-ready markdown
npx brnstrm add-note <board> --name "API" --section "Backend" --content "..."
npx brnstrm connect <board> --from "Goals" --to "API" --label "drives"
npx brnstrm arrange <board>             # arrow-aware auto layout
```

The same arrow-aware layout is a click away in the UI — the **arrange** button
next to **recenter** force-directs the current board, pulling connected notes
together while keeping each note inside its section (with one-tap undo).

Every mutation runs through the same storage layer the UI uses (so section
folders and arrows stay consistent), and boards are plain git-tracked files, so
agent edits are reviewable with `git diff` and reversible like any other change.

`npx brnstrm init` installs this skill for your agent (Claude Code, Cursor, or a
generic `AGENTS.md`), so the read → reason → write loop is taught automatically.