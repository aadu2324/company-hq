# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-11-26

### Added
- **Research mode.** A `frontier` team (Research Director, Chief Scientist, Frontier & Gap Discovery, Theory &
  Proofs, Experiments, Writing & Submission) with strict verification, and research playbooks for AI, mathematics
  and physics. New agents: `co-gap-analyst` (frontier and market gaps, each checked to be still open),
  `co-theorist` (formal statements, proof attempts, counterexample search, Lean 4) and `co-proof-verifier`
  (adversarial step-by-step checking, counterexamples, Lean builds).
- **Owner checkpoints.** A plan can stop at a question only the owner can answer ("which gap?", "which idea?").
  The run waits (**NEEDS YOU**), `/hq answer` or the pane's answer box records the choice, and the CEO re-plans
  the rest around it, keeping finished work.
- **Startup gap discovery.** With no idea given, startup teams find underserved problems with evidence of demand
  and ask which to pursue before building.
- **Second brain.** Papers, research gaps, market opportunities and per-field hubs are filed into the Obsidian vault
  as linked notes, written once so your annotations survive.
- **Research watch.** `hq watch` checks arXiv and Hacker News daily for every tracked field, files new papers,
  flags ones that may affect an open gap, and writes a daily digest. No Claude calls, no usage.
  `hq watch --schedule` sets it up.
- Research integrity rules for research teams: nothing is called proved, solved, novel or state of the art unless
  the run checked it.

## [0.3.1] - 2026-11-26

### Fixed
- After a usage limit, tasks still waiting for a Claude slot stop waiting at once, so the run pauses instead of
  staying "executing" until a slot frees up.
- A task cut short because a sibling hit the limit keeps its manager's conversation, like the task that hit it.
- A run paused during a revision round resumes that round with the reviewer's feedback, instead of starting the
  task over and resetting its revision budget.
- The Obsidian folder setting can no longer point at a sibling folder whose name starts with the vault's name.
- Two runs started in the same minute with the same request get separate Obsidian notes (the run id is in the name).
- A review verdict parsed from free text with malformed issues no longer breaks the pane.
- The "running" timer of a resumed run counts from the resume.

### Changed
- Documented that the lean profile turns off your hooks in background processes, and added `"isolate": false`
  to keep them.

## [0.3.0] - 2026-11-24

### Added
- **Pause and resume on the usage limit.** When Claude's usage limit stops a process, the run pauses
  instead of failing: approved tasks stay approved, interrupted tasks keep their manager's conversation, and
  the pane shows when the limit resets. `/hq resume` (or the **Resume run** button) carries on without
  re-planning or redoing approved work. Failed, stopped and partly failed runs can be resumed too.
- **Lean profile, now the default.** Measured on real runs, review panels of 4–5 reviewer subagents were
  ~64% of the spend, and every background process carried ~77k tokens of hooks, MCP servers and skills.
  Lean reviews each task in one pass from up to 2 perspectives with 1 revision round, plans at most 4 tasks,
  runs everything on Sonnet at medium effort, and starts background processes without hooks, MCP servers or
  skills (agents and CLAUDE.md are kept): about 58% less context per call and roughly 2× faster.
  `"profile": "thorough"` restores the previous behaviour.
- **Obsidian integration.** With `"obsidian": { "vault": "…" }` in `~/.claude/company/config.json`, every
  run becomes a note (status, plan, tasks, verdicts, Board decision, links to the report) with a per-project
  index and an `HQ` dashboard, linked to the project's own note. `hq obsidian` exports existing runs.
- **See what HQ is doing.** A Live card lists each running process with a live timer, what a queued run is
  waiting for (which run, in which project, holds the Claude slots, or how much memory is free), a sweeping
  activity bar while work is happening, slot dots in the header, and "updated Xs ago".
- Task cards open to show the brief, deliverable and the review's open issues. Tasks approved after the last
  revision round with issues still open are flagged `APPROVED ⚠`.

### Fixed
- A stopped run no longer logs its end several times.
- The Board report path works on macOS and Linux.

## [0.2.0] - 2026-11-23

The whole company now ships in the plugin: install once and `/hq init`, `/hq run` work out of the box.

### Added
- A redesigned HQ pane: status pills, a Plan → Build → Review → Board → Report pipeline, a plain-language
  "Now" line (including when Claude's usage limit paused the work and when it resets), a native progress bar,
  Overview / Team / Tasks / Activity tabs (keys 1–4), department and task cards, colour-coded activity,
  a box to ask the company for work, a past-run picker and an animated spinner while a run is live.
- A colourful status row above the prompt with a block progress bar and the current activity.
- An animated preview in the README (`assets/hq-demo.svg`, generated by `scripts/make-demo-svg.mjs`).
- The HQ engine (`engine/`): CEO planning, parallel department managers, review panels with revision
  rounds, Board sign-off and `report.md`, under a memory-aware limit on concurrent Claude processes.
- 19 role agents (`agents/co-*.md`), from Board and CEO to copywriter, methodologist and legal counsel.
- Startup, research and software team templates, tailored to each repo by the org designer.
- The `company` skill for running the same process interactively in a chat.
- Agent resolution: each role lists the agents it prefers. ECC agents are used when ECC is installed;
  otherwise the bundled agents, then `general-purpose` with the role's charter.
- Chat delegation logging inside the mod (no settings.json hook needed).
- `vramGB` setting; the engine detects RAM itself and tells workers what the machine can take.
- macOS and Linux support for stopping runs.

### Changed
- `/hq` commands run the bundled engine instead of `~/.claude/company/hq`.
- Catalog and templates are read from the plugin, with optional overrides in `~/.claude/company/`.
- Headless sessions no longer start the 2-second refresh timer.

## [0.1.1] - 2026-11-23

### Added
- MIT license, plugin icon, and full manifest metadata.
- README with install steps, quick start, commands, architecture and FAQ.
- Contributing guide and security policy.

## [0.1.0] - 2026-11-23

### Added
- HQ side pane: live org chart, runs, task status and verdicts, Board decision and activity feed.
- Corner widget form of the pane.
- Status row above the prompt with Open and Hide buttons.
- `/hq`, `/hq run`, `/hq init`, `/hq stop` and `/hq status` commands.

[0.4.0]: https://github.com/aadu2324/company-hq/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/aadu2324/company-hq/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/aadu2324/company-hq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aadu2324/company-hq/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/aadu2324/company-hq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aadu2324/company-hq/releases/tag/v0.1.0
