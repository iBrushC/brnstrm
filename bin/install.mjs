#!/usr/bin/env node
// brnstrm project installer — `npx brnstrm init`.
//
// Sets up brnstrm in whatever project you run it from. Deliberately tiny: it
// only touches what's needed to start brainstorming and hand boards to an agent.
//
//   1. Creates a `.brnstrm/` folder (where this project's boards live).
//   2. Asks whether the boards should be git-tracked, and edits `.gitignore`
//      accordingly.
//   3. Asks which coding agent(s) you use and installs the brnstrm skill for
//      each, so the agent knows how to read and write your boards.
//
// Zero dependencies (Node built-ins only) and no assumptions about the host
// project — it works whether or not the project uses Node/npm. The only
// requirement is Node on the machine, which `npx` already implies.
//
// Non-interactive use (CI, scripts):
//   npx brnstrm init --yes                 accept defaults (track in git, no skill)
//   npx brnstrm init --git --agents=claude,cursor
//   npx brnstrm init --no-git --agents=agents
//   npx brnstrm init --agents=none         just create the folder
// Flags: --yes/-y, --git, --no-git, --agents=<list>, --force, --help/-h

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/* ---------------- where ---------------- */
// npm/npx sets INIT_CWD to the directory the user ran the command from; fall
// back to cwd when run directly (e.g. `node bin/install.mjs`).
const PROJECT_ROOT = process.env.INIT_CWD || process.cwd();
const BRNSTRM_DIR = path.join(PROJECT_ROOT, ".brnstrm");

/* ---------------- flags ---------------- */
const argv = process.argv.slice(2).filter((a) => !["init", "setup", "install"].includes(a));
const flags = parseFlags(argv);

if (flags.help) {
  printUsage();
  process.exit(0);
}

const interactive = process.stdin.isTTY && process.stdout.isTTY && !flags.yes;

/* ---------------- the known agents ---------------- */
// Each agent describes where its skill/rules file lives and how to render it.
const AGENTS = [
  {
    key: "claude",
    label: "Claude Code",
    file: ".claude/skills/brnstrm/SKILL.md",
    render: renderClaudeSkill,
  },
  {
    key: "cursor",
    label: "Cursor",
    file: ".cursor/rules/brnstrm.mdc",
    render: renderCursorRule,
  },
  {
    key: "agents",
    label: "Generic AGENTS.md (Codex, Copilot CLI, Windsurf, others)",
    file: "AGENTS.md",
    render: null, // appended, not overwritten — handled specially
  },
];

async function main() {
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  banner();

  /* --- step 1: the folder --- */
  const dirExisted = fs.existsSync(BRNSTRM_DIR);
  fs.mkdirSync(BRNSTRM_DIR, { recursive: true });
  log(
    dirExisted
      ? `• .brnstrm/ already exists — leaving it in place`
      : `• created .brnstrm/  (your boards will live here)`
  );

  /* --- step 2: git tracking --- */
  const gitRoot = findGitRoot(PROJECT_ROOT);
  let track = null;
  if (!gitRoot) {
    log(`• no git repository found — skipping the git question`);
  } else {
    track = await decideGitTracking(rl);
    if (track) {
      // git won't track an empty folder; a .gitkeep makes it show up right away.
      const keep = path.join(BRNSTRM_DIR, ".gitkeep");
      if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
      ensureNotIgnored(gitRoot);
      log(`• boards will be tracked in git (reviewable with \`git diff .brnstrm/\`)`);
    } else {
      addToGitignore(gitRoot);
      log(`• added .brnstrm/ to .gitignore — boards stay local`);
    }
  }

  /* --- step 3: the skill --- */
  const chosen = await decideAgents(rl);
  if (!chosen.length) {
    log(`• no skill installed (you can re-run \`npx brnstrm init\` anytime)`);
  } else {
    for (const agent of chosen) await installSkill(agent, rl);
  }

  if (rl) rl.close();
  done(track, chosen);
}

/* ============================================================ steps ===== */

async function decideGitTracking(rl) {
  if (flags.git === true) return true;
  if (flags.git === false) return false;
  if (!interactive) return true; // default: track, so boards are shareable
  return maybeConfirm(
    rl,
    "Track your boards in git? Boards are plain files — tracking lets your team\n" +
      "  share them and review agent edits with `git diff`",
    true
  );
}

async function decideAgents(rl) {
  // Explicit --agents wins (including --agents=none).
  if (flags.agents !== undefined) {
    if (flags.agents.includes("none")) return [];
    return AGENTS.filter((a) => flags.agents.includes(a.key));
  }
  if (!interactive) return []; // don't touch agent config unasked-for

  log("");
  log("Which coding agent(s) do you use? The brnstrm skill teaches them to read");
  log("and write your boards. Choose any that apply:");
  AGENTS.forEach((a, i) => log(`  ${i + 1}) ${a.label}`));
  log(`  0) none / skip`);
  const answer = await ask(
    rl,
    "Enter numbers (comma-separated), names, or 0 to skip [0]: "
  );
  return parseAgentChoice(answer);
}

async function installSkill(agent, rl) {
  const dest = path.join(PROJECT_ROOT, agent.file);

  if (agent.key === "agents") {
    return upsertAgentsMd(dest, rl);
  }

  // Picking the agent (menu or --agents) is the opt-in. The only thing left to
  // confirm is clobbering a file that's already there.
  if (fs.existsSync(dest) && !flags.force) {
    const ok = await maybeConfirm(
      rl,
      `${agent.file} already exists — overwrite the brnstrm skill?`,
      false
    );
    if (!ok) {
      log(`  ↳ skipped ${agent.label} (kept existing file)`);
      return;
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, agent.render());
  log(`  ✓ wrote ${agent.file}`);
}

// AGENTS.md is a shared, human-edited file — append (or refresh) a fenced
// brnstrm section between markers rather than clobbering the whole file.
async function upsertAgentsMd(dest, rl) {
  const START = "<!-- brnstrm:start -->";
  const END = "<!-- brnstrm:end -->";
  const block = `${START}\n\n${renderAgentsSection()}\n${END}`;

  let existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  const hasBlock = existing.includes(START) && existing.includes(END);

  let next;
  if (hasBlock) {
    next = existing.replace(
      new RegExp(`${START}[\\s\\S]*?${END}`),
      block.replace(/\$/g, "$$$$") // escape $ for replace()
    );
  } else {
    const sep = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
    next = existing + sep + block + "\n";
  }
  fs.writeFileSync(dest, next);
  log(`  ✓ ${hasBlock ? "refreshed" : "added"} brnstrm section in AGENTS.md`);
}

/* ============================================ git helpers ===== */

function findGitRoot(start) {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const IGNORE_LINE = ".brnstrm/";

function addToGitignore(gitRoot) {
  const file = path.join(gitRoot, ".gitignore");
  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (gitignoreHas(content, IGNORE_LINE)) return;
  const sep = content && !content.endsWith("\n") ? "\n" : "";
  content += `${sep}\n# brnstrm boards (kept local)\n${IGNORE_LINE}\n`;
  fs.writeFileSync(file, content);
}

// If the user wants tracking but a previous run (or hand edit) ignored the
// folder, comment that line out so git can actually see the boards.
function ensureNotIgnored(gitRoot) {
  const file = path.join(gitRoot, ".gitignore");
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8");
  if (!gitignoreHas(content, IGNORE_LINE)) return;
  const next = content
    .split(/\r?\n/)
    .map((line) =>
      line.trim() === IGNORE_LINE || line.trim() === ".brnstrm"
        ? `# ${line}   # brnstrm: now tracked`
        : line
    )
    .join("\n");
  fs.writeFileSync(file, next);
  log(`• un-ignored .brnstrm/ in .gitignore (was previously ignored)`);
}

function gitignoreHas(content, line) {
  const norm = line.replace(/\/$/, "");
  return content
    .split(/\r?\n/)
    .some((l) => {
      const t = l.trim();
      return t === line || t === norm;
    });
}

/* ============================================ prompt helpers ===== */

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function maybeConfirm(rl, question, def) {
  if (!interactive) return def;
  const hint = def ? "[Y/n]" : "[y/N]";
  const a = (await ask(rl, `  ${question} ${hint} `)).toLowerCase();
  if (a === "") return def;
  return a === "y" || a === "yes";
}

function parseAgentChoice(answer) {
  if (!answer || answer === "0") return [];
  const tokens = answer
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const picked = new Set();
  for (const t of tokens) {
    if (t === "0" || t === "none") return [];
    const byNum = AGENTS[Number(t) - 1];
    if (byNum) {
      picked.add(byNum);
      continue;
    }
    const byKey = AGENTS.find((a) => a.key === t || a.label.toLowerCase().startsWith(t));
    if (byKey) picked.add(byKey);
  }
  return [...picked];
}

function parseFlags(args) {
  const f = { git: undefined, agents: undefined };
  for (const a of args) {
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--git") f.git = true;
    else if (a === "--no-git") f.git = false;
    else if (a === "--force") f.force = true;
    else if (a === "--help" || a === "-h") f.help = true;
    else if (a.startsWith("--agents=")) {
      f.agents = a
        .slice("--agents=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return f;
}

/* ============================================ skill content ===== */

// One shared body of instructions, rendered into each agent's native format.
// Commands use `npx brnstrm` so they're portable in any project that installed
// brnstrm, and boards are referenced as `.brnstrm/` (this project's data dir).
function skillBody() {
  return `\
\`brnstrm\` is a visual brainstorming tool. A **board** holds **notes** (free-text
cards), **sections** (boxes that group notes), and **connections** (labeled
arrows describing relationships). Boards live as plain files under \`.brnstrm/\`,
so they double as a project-wide, multimodal knowledge base you share with the
human.

Everything you need is one CLI — no server required:

\`\`\`
npx brnstrm <command> [args]
\`\`\`

Run \`npx brnstrm help\` for the exact command list. \`<board>\` accepts a board id,
its folder slug, or its display name.

## The loop: read → reason → write

1. **See what's there.** \`list\`, then \`read <board>\` for the whole board (or
   \`--section S\` / \`--note N\` for one piece). Read before you write.
2. **Reason** about it as a specification of ideas — that's what it is.
3. **Write back** only what the human asked for. Prefer a few well-named notes
   over many tiny ones. Name every note and section you create.

## Reading

\`\`\`
npx brnstrm list                          # id<TAB>name for every board
npx brnstrm read "Migration Plan"          # whole board → markdown
npx brnstrm read my-board --section Skills  # just one section
npx brnstrm resources my-board             # attached reference files
\`\`\`

## Writing

Note bodies are **markdown**. Add a note straight into a section — geometry is
computed for you, so you never deal with pixel coordinates:

\`\`\`
npx brnstrm new-board "Migration Plan"
npx brnstrm add-section my-board --label "Backend"
npx brnstrm add-note my-board --name "API" --section "Backend" \\
  --content "REST endpoints over the storage layer"
npx brnstrm connect my-board --from "Goals" --to "API" --label "drives"
\`\`\`

Edit or remove with \`set-note\` / \`set-section\` / \`rm-note\` / \`rm-section\` /
\`rm-connection\`. Every mutating command prints the affected ids as JSON — keep
them so you can reverse a change with the matching \`rm-*\` / \`set-*\`.

After building a board from scratch, tidy it:

- **\`arrange <board>\`** — arrow-aware force-directed layout (reflows positions).
- **\`format <board>\`** — snap to grid + wrap sections without reflowing.

## Rules of thumb

- **Read before writing.** Don't duplicate a note that already exists.
- **Always name notes and sections** — names are how arrows and humans refer to
  them.
- **Edits are reversible two ways:** the printed ids (undo with \`rm-*\`/\`set-*\`)
  and git (\`git diff .brnstrm/\` shows exactly what changed).
- **Place notes in sections** rather than loose, so they group correctly both on
  the canvas and in the exported markdown.`;
}

const DESCRIPTION =
  "Read and write brnstrm brainstorm boards — the visual idea boards under this " +
  "project's .brnstrm/ folder. Use when asked to review, summarize, give feedback " +
  "on, or implement from a board; to turn a plan/summary into a board; or to add " +
  "notes, sections, or arrows to one.";

function renderClaudeSkill() {
  return `---
name: brnstrm
description: ${DESCRIPTION}
---

# Working with brnstrm boards

${skillBody()}
`;
}

function renderCursorRule() {
  return `---
description: ${DESCRIPTION}
globs:
alwaysApply: false
---

# Working with brnstrm boards

${skillBody()}
`;
}

function renderAgentsSection() {
  return `## Working with brnstrm boards

${skillBody()}`;
}

/* ============================================ output ===== */

function banner() {
  log("");
  log("🧠 brnstrm setup");
  log(`   project: ${PROJECT_ROOT}`);
  log("");
}

function done(track, chosen) {
  log("");
  log("✓ Done.");
  log("");
  log("Next:");
  log("  npx brnstrm            # open the visual workspace at http://localhost:8888");
  log("  npx brnstrm new-board \"My First Board\"");
  log("  npx brnstrm list");
  if (chosen.length) {
    log("");
    log(`Your agent (${chosen.map((a) => a.label.split(" (")[0]).join(", ")}) now`);
    log("knows how to read and write these boards. Try: \"summarize the brnstrm board\".");
  }
  log("");
}

function log(msg) {
  process.stdout.write(msg + "\n");
}

function printUsage() {
  log(`brnstrm init — set up brnstrm in this project

Usage
  npx brnstrm init                  interactive setup
  npx brnstrm init --yes            non-interactive, accept defaults
  npx brnstrm init --no-git --agents=claude,cursor,agents

Flags
  --yes, -y         non-interactive; defaults to git-tracked, no skill
  --git / --no-git  track boards in git, or add .brnstrm/ to .gitignore
  --agents=<list>   comma list of: claude, cursor, agents, none
  --force           overwrite existing skill files without asking
  --help, -h        this message

What it does
  1. creates .brnstrm/  (where this project's boards live)
  2. edits .gitignore to match your git choice
  3. installs the brnstrm skill for the agent(s) you pick`);
}

/* ============================================ go ===== */

main().catch((err) => {
  process.stderr.write("\nerror: " + (err && err.message ? err.message : err) + "\n");
  process.exit(1);
});
