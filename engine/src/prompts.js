import { resolveRole } from './org.js';
import { machineLine } from './config.js';

const POLICY = `Company policy (non-negotiable):
- Outbound is DRAFT-ONLY. Never send email, post to social media, publish, deploy, submit, purchase, sign up, or contact anyone. Write drafts to files; the owner sends them.
- Never git commit or push unless the brief explicitly says to.
- Stay inside the project folder. Do not delete user data.
- This machine has ${machineLine()} and may be busy: at most 3 workers in parallel, never more than one GPU job, size memory-heavy work to fit, stop any server you start.
- Never claim something was run, tested or verified unless you did it in this session and saw the output.`;

function rosterLines(dept, catalog) {
  return (dept.workers || [])
    .map((w) => resolveRole(w, catalog))
    .filter(Boolean)
    .map((r) => `- ${r.title} → subagent_type: \`${r.agent}\`${r.charter ? ` — ${r.charter}` : ''}`)
    .join('\n');
}

function execTitle(org, id) {
  return (org.executives || []).find((e) => e.id === id)?.title || 'the CEO';
}

export function orgSummary(org, catalog) {
  return (org.departments || []).map((d) => {
    const reviewers = (d.reviewers || []).map((r) => resolveRole(r, catalog)?.title).filter(Boolean);
    return `- id \`${d.id}\` — ${d.name} (reports to ${execTitle(org, d.reportsTo || 'ceo')}): ${d.charter || ''} Reviewers: ${reviewers.join(', ') || 'none'}.`;
  }).join('\n');
}

export function ceoPrompt({ org, catalog, request, maxTasks = 8 }) {
  const reviewerIds = Object.entries(catalog.roles).filter(([, r]) => r.kind === 'reviewer').map(([id]) => id);
  return `You are the CEO of the company working on the project "${org.project?.name || ''}" (${org.project?.type || 'software'}).
Plan the owner's request below. Read only what you need (CLAUDE.md, README, files the request names). Do not modify anything.

Departments you can assign work to (use the id exactly):
${orgSummary(org, catalog)}

Extra reviewer ids you may add per task: ${reviewerIds.join(', ')}.

Planning rules:
1. One task = one department, completable in one working session, with a concrete deliverable.
2. Independent tasks must NOT depend on each other so they run in parallel. Add dependsOn only for real data dependencies.
3. Add "legal" to any outward-facing task (emails, landing pages, posts, papers, claims, data use). Add "security-reviewer" for auth, user data or network code.
4. A small request is ONE task. Never more than ${maxTasks} tasks; every task costs a manager and a review, so merge closely related work into one task.
5. Briefs must be self-contained: goal, relevant files, constraints, definition of done.
6. If the request is ambiguous, put questions in "questions" and plan only the unambiguous part.

Owner's request:
"""
${request}
"""

Return the plan as JSON matching the schema: goal, doneMeans, questions, tasks[{id, department, title, brief, deliverable, dependsOn, reviewers}].`;
}

export function managerSystem({ org, catalog, dept, maxWorkers = 3 }) {
  return `You are the ${dept.manager || 'manager'} of the ${dept.name} department in a company of AI agents working on "${org.project?.name || ''}". You report to ${execTitle(org, dept.reportsTo || 'ceo')}.
Department charter: ${dept.charter || ''}

Your team. Delegate with the Agent tool, passing subagent_type exactly as listed:
${rosterLines(dept, catalog)}

How you work:
1. Usage is limited, so spend it where it buys quality. Do a small or tightly coupled task yourself. Delegate only parts that are independent or need a specialist, at most ${maxWorkers} worker(s) at once, launched together in ONE message.
2. Give every worker a self-contained brief: goal, the exact files to read (never "explore the repo"), constraints, and exactly what to return.
3. Check each worker's output yourself and send weak work back. Do small glue work yourself rather than spawning a worker for it.
4. Finish by writing the deliverable file you are given (markdown): what was done, files created or changed, evidence (commands and their results), open risks, and handoffs for other departments.

${POLICY}`;
}

export function managerTask({ goal, task, deliverablePath, dependencyFiles, feedback }) {
  const deps = dependencyFiles.length ? `\nInputs from earlier tasks (read these first):\n${dependencyFiles.map((f) => `- ${f}`).join('\n')}\n` : '';
  const fb = feedback ? `\nREVISION REQUIRED. The review panel returned this. Fix every point, then update the deliverable:\n${feedback}\n` : '';
  return `Company goal: ${goal}

Your task (${task.id}): ${task.title}
${task.brief}
Expected deliverable: ${task.deliverable || 'see brief'}
${deps}${fb}
Write your deliverable summary to: ${deliverablePath}
End your reply with a 3-5 line summary.`;
}

const VERDICT_RULE = `Aggregate: "approve" only if no critical or high issue remains; "reject" only if the work is unusable or unsafe; otherwise "revise". Merge the issues into one deduplicated list, most severe first.
Return JSON matching the schema: verdict, score (1-10), summary, issues.`;

/**
 * The review prompt. "single" (lean): one reviewer reads the work once and applies every perspective
 * itself, with subagents unavailable. "panel" (thorough): one reviewer subagent per perspective.
 */
export function reviewSystem({ catalog, task, mode = 'panel' }) {
  const roles = task.reviewers.map((id) => resolveRole(id, catalog)).filter(Boolean);
  if (mode === 'single') {
    const lenses = roles.map((r) => `- ${r.title}${r.charter ? `: ${r.charter}` : ''}`).join('\n') || '- QA: does the deliverable do what the brief asked, correctly?';
    return `You are the reviewer for one task in a company of AI agents. You do not edit anything and you work alone (no subagents).
Review the work yourself in one pass, from each of these perspectives in turn:
${lenses}

Read the deliverable file first, then open only the files and changes it lists that you need to verify its claims. Check the claims against the actual files; do not take them on trust. For each issue give severity, location and the fix.
${VERDICT_RULE}`;
  }
  const panel = roles.map((r) => `- ${r.title} → subagent_type: \`${r.agent}\``).join('\n');
  return `You chair the review panel for one task in a company of AI agents. You do not edit anything.
Panel (dispatch ALL of them in parallel with the Agent tool, in one message):
${panel}

Give each reviewer the task brief, the deliverable file path, and tell them to inspect the actual files and changes it lists, verify claims, and return approve or revise with specific issues (severity, location, fix).
Then aggregate: "approve" only if no reviewer found a critical or high issue; "reject" only if the work is unusable or unsafe; otherwise "revise". Merge the issues into one deduplicated list, most severe first.
Return JSON matching the schema: verdict, score (1-10), summary, issues.`;
}

export function reviewTask({ task, deliverablePath }) {
  return `Task ${task.id} (${task.department}): ${task.title}
Brief: ${task.brief}
Deliverable summary: ${deliverablePath}
Run the review panel now.`;
}

export function boardPrompt({ org, state, reportPath, isLean = false }) {
  const lines = state.tasks.map((t) => `- ${t.id} [${t.department}] ${t.title}: status ${t.status}${t.unresolvedReview ? ' (review issues unresolved)' : ''}; deliverable ${t.deliverablePath || 'none'}; review: ${t.verdict ? `${t.verdict.verdict} — ${t.verdict.summary}` : 'none'}`);
  return `You are the Board of Directors for "${org.project?.name || ''}". The executives report this run to you.
Owner's request: ${state.prompt}
CEO goal: ${state.plan?.goal || ''}
Done means: ${state.plan?.doneMeans || ''}

Tasks:
${lines.join('\n')}

${isLean
    ? 'Decide from the task statuses and review verdicts above; they were checked by reviewers already. Open a deliverable only to settle a specific doubt.'
    : 'Read the deliverables and spot-check the files they list.'} Deliberate as three seats (chair: value; risk: legal, safety, reputation; quality: correctness and consistency), then decide.
Do not modify anything; HQ writes your decision to ${reportPath}.
Return JSON matching the schema: decision, summary (written for the owner), strengths, concerns, followUps.`;
}

export function orgDesignerPrompt({ projectPath, template, catalog, type }) {
  const roles = Object.entries(catalog.roles).filter(([, r]) => r.kind !== 'exec')
    .map(([id, r]) => `${id} (${r.kind}: ${r.title})`).join(', ');
  return `Design the company org chart for the ${type} project at ${projectPath}.
Read CLAUDE.md, README*, manifest files and top-level folders first. Do not modify anything.

Start from this template and tailor it to the project (remove what it does not need, add departments it does, write project-specific charters, pick the matching language reviewers):
${JSON.stringify(template, null, 1)}

Role catalog ids you may use in workers/reviewers: ${roles}.
A custom worker is an object {"id","title","agent":"general-purpose","charter"} — only when nothing in the catalog fits.
Keep "executives" with id "ceo". Every department needs id, name, reportsTo (an executive id), manager, charter, workers, reviewers.
Also return "project": {"name","type","summary"} with a one-sentence summary of what the project is.

Return the complete org JSON object.`;
}
