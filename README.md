# company-hq

A Claude Code mod that shows how a project's "company" of agents is working, right beside the chat.

- **Row above the prompt:** `HQ · <project> · ▶ executing 2/5 tasks · 3 agent(s) working [Open] [Hide]`
- **`/hq`** opens a dockable side pane: the org chart (Board, executives, departments, managers, workers,
  reviewers) with live workers highlighted, recent runs with each task's status and review verdicts, the
  Board decision, and an activity feed. Minimised, it becomes a small corner widget.
- **`/hq run <request>`**, **`/hq init [startup|research|software]`**, **`/hq stop`**, **`/hq status`**

It reads files only (every 2 s) and uses no tokens.

## Install

At the prompt of a terminal session:

```
/plugin install company-hq --marketplace aadu2324/company-hq
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install company-hq --marketplace aadu2324/company-hq
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with
`aadu2324/company-hq` → **Add plugin**.

## What it reads

| Path | Contents |
|---|---|
| `<project>/.company/org.json` | the project's team |
| `<project>/.company/runs/<id>/state.json`, `events.jsonl` | runs, tasks, verdicts, activity |
| `<project>/.company/events.jsonl` | delegation from ordinary chat sessions |
| `~/.claude/company/catalog.json` | role id → title and agent |

The `/hq run`, `init`, `stop` and `status` commands call the Claude HQ engine at
`~/.claude/company/hq/bin/hq.js` (Node). The engine is not part of this repository; without it the pane
still renders any `.company/` files it finds, and the commands report that the engine is missing.

## Develop

```
claude plugin validate .
claude plugin test .
```
