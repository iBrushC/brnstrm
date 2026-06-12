# 🧠 brnstrm 🌪️
We don't think in just text, why should we be restricted when making code? `brnstrm` is a simple workspace for brainstorming, planning, and managing implementation details for complex projects. Manage ideas, build diagrams, include references, and more, then hand off to your coding agent of choice to handle the implementation.

## Usage
To install, just run

```
npm i brnstrm
```

Then run

```
npx brnstrm
```

to start the server. It will automatically start the workspace at `localhost:1098` where the workspace will be configured. 

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
In the future, you'll be able to brainstorm with agents, defining the general system then breaking it into manageable, well-defined chunks and systems before executing.