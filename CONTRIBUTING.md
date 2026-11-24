# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Layout

| Path | What it is |
|---|---|
| `hooks/register.tsx` | The mod's hooks: session start, `/hq`, chat delegation logging, rendering entry points |
| `hooks/model.ts` | Pure functions from `.company` files to what is drawn: stages, plain-language status, colours |
| `hooks/view.tsx` | The pane, corner widget and status row |
| `engine/` | The orchestrator (Node ≥ 20), role catalog and team templates |
| `agents/`, `skills/` | The bundled role agents and the interactive `company` skill |

## Before you open a pull request

1. `claude plugin validate .` reports nothing new.
2. `claude plugin test .` and `cd engine && npm test` both pass. Add a test for new behaviour; for every
   "this is shown" assertion, also check the case where it must not be.
3. If you change the shape of `Snapshot` in `types/index.d.ts`, bump the `shape` tag on the `snapshot` atom in
   `hooks/register.tsx` (for example `snap-2` → `snap-3`), so a value an older version stored is ignored.
4. If the pane's look changes, regenerate the README animation: `node scripts/make-demo-svg.mjs`.
5. Add a line to `CHANGELOG.md` under an `Unreleased` heading.

## Guidelines

- The mod reads files and draws them. Keep it free of model calls and network requests.
- Anything that changes files or starts Claude processes belongs in the engine, called through `/hq`.
- Drawing must never fail: a half-written `state.json` keeps the last good view.
- The company is drafts-only. Do not add anything that sends, posts, publishes or purchases.

## Reporting a bug

Open an issue with your Claude Code version (`claude --version`), whether you use the terminal or the desktop
app, your OS, what you expected and what happened. The run's `.company/runs/<id>/engine.log` helps, with
anything private removed.
