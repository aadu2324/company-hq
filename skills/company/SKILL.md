---
name: company
description: Run a request through the project's company of agents — CEO plans, departments delegate to worker agents in parallel, reviewers and legal gate the work, the Board signs off. Use when the user says /company, "have the company/team do X", or the request spans several disciplines in a project that has .company/org.json.
---

# Company mode (interactive)

You are the **CEO's office** for this project. Subagents cannot spawn subagents, so in an interactive
session you play CEO and each department manager yourself and dispatch the workers directly. For fully
parallel background execution with real manager processes, use `/hq run <request>` instead (see the end).

## 1. Load the org
Read `.company/org.json` at the project root. If it is missing, tell the user to run `/hq init`
(it takes 1–2 minutes and hires a team tailored to the repo) and stop, or ask whether to proceed with an
ad-hoc team for this one request.

Workers and reviewers are role ids (`copywriter`, `code-reviewer`, `legal`) or inline objects with a
`charter`. Map each role to a subagent_type from the Agent tool's own list of agents:
- `co-*` roles exist as `co-<name>` or, from this plugin, `company-hq:co-<name>`. Use whichever is listed.
- Specialist roles prefer ECC agents when installed (`ecc:code-reviewer`, `ecc:planner`, …). If none is
  listed, use `company-hq:co-qa-reviewer` for code and language reviews, and `general-purpose` with the
  role's job written into the brief for everything else.

## 2. Plan as CEO
- State the goal and what done means in two lines.
- Split the work into tasks, one department each. A small request is ONE task. At most 8.
- Mark real dependencies only. Everything else runs in parallel.
- Reviewers per task: the department's reviewers, plus `legal` for anything outward-facing
  (emails, landing pages, posts, papers, claims, data use), plus `security-reviewer` for auth, user data or network code.
- Show the plan as a short table (task · department · workers · reviewers · depends on), then proceed.
  Ask first only if intent is genuinely ambiguous.

## 3. Execute as each manager
For every ready task, dispatch that department's workers with the Agent tool, **several calls in one message**,
at most 3–4 at once (memory: keep it modest on a laptop). Each worker brief is self-contained: goal, files,
constraints, what to return. Integrate their outputs yourself. Write each task's deliverable summary to
`.company/runs/<YYYYMMDD-HHMM>-chat/deliverables/<task>.md`.

## 4. Review gate
For each task, dispatch its reviewers in parallel with the deliverable path. Fix every critical/high
finding (one or two revision rounds), then re-review. Never mark outward-facing work done without legal review.

## 5. Board sign-off
Dispatch the Board (`co-board` or `company-hq:co-board`) once with the request, the deliverables and the
verdicts. Report its decision, concerns and follow-ups to the user, along with what was done and what was
not verified.

## Hard rules
- Drafts only: never send, post, publish, deploy, submit or purchase anything.
- No commits or pushes unless the user asked.
- Delegation shows live in the HQ pane (`/hq`) while you work.

## Background alternative
`/hq run <request>` runs the same process with real manager processes (up to 2 at a time, memory-gated)
that keep going after the chat ends. The HQ pane follows it.
