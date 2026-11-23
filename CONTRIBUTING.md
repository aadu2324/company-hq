# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you open a pull request

1. Run `claude plugin validate .` and fix anything it reports.
2. Run `claude plugin test .` and keep every test passing. Add a test for new behaviour in `hq.test.tsx`.
3. If you change the shape of `Snapshot` in `types/index.d.ts`, bump the `shape` tag on the `snapshot` atom
   in `hooks/register.tsx` (for example `snap-1` → `snap-2`), so a value an older version stored is ignored.
4. Add a line to `CHANGELOG.md` under an `Unreleased` heading.

## Guidelines

- The mod reads files and draws them. Keep it free of model calls and network requests.
- Anything that changes files or starts processes belongs in the HQ engine, called through `/hq` commands.
- Keep functions small and fail quietly while drawing: a half-written `state.json` should never break the pane.

## Reporting a bug

Open an issue with your Claude Code version (`claude --version`), whether you use the terminal or the desktop
app, what you expected, and what happened. A copy of the `.company/org.json` involved helps, with anything
private removed.
