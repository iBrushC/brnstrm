#!/usr/bin/env node
// Unified `brnstrm` entry point. One bin, three jobs:
//
//   brnstrm                 start the board server (browser workspace)
//   brnstrm serve|start     ... same thing, explicitly
//   brnstrm init|setup      interactive project setup (.brnstrm + skill)
//   brnstrm <agent-command> read / list / add-note / connect / ... (agent CLI)
//
// Keeping everything under one bin means the agent commands a skill documents
// are portable: `npx brnstrm read <board>` works in any project that installed
// brnstrm, with no path juggling.

const [cmd] = process.argv.slice(2);

const SERVER_CMDS = new Set(["serve", "start", "server"]);
const INIT_CMDS = new Set(["init", "setup", "install"]);

async function main() {
  if (INIT_CMDS.has(cmd)) {
    // The installer reads process.argv for its own flags.
    await import("./install.mjs");
    return;
  }

  if (cmd === undefined || SERVER_CMDS.has(cmd)) {
    // Starting the server is a side effect of importing it.
    await import("../server.js");
    return;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    const { HELP } = await import("./brnstrm.mjs");
    process.stdout.write(TOP_HELP + "\n" + HELP);
    return;
  }

  // Anything else is an agent CLI command.
  const { run } = await import("./brnstrm.mjs");
  run(process.argv.slice(2));
}

const TOP_HELP = `brnstrm — a brainstorming workspace for human + agent collaboration

Usage
  brnstrm                 start the board server at http://localhost:8888
  brnstrm init            set up brnstrm in this project (.brnstrm + skill)
  brnstrm <command> ...   run an agent command (see below)

The agent commands:
`;

main().catch((err) => {
  process.stderr.write("error: " + (err && err.message ? err.message : err) + "\n");
  process.exit(1);
});
