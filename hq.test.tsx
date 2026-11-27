import { expect, test } from 'claude-code/testing'

// A fake project on a fake disk. Fixtures are built with JSON.stringify, never hand-escaped.
const ORG = {
  project: { name: 'Acme', type: 'startup' },
  executives: [{ id: 'ceo', title: 'CEO' }, { id: 'cto', title: 'CTO', reportsTo: 'ceo' }],
  departments: [
    { id: 'engineering', name: 'Engineering', reportsTo: 'cto', manager: 'Eng Manager', workers: ['builder'], reviewers: ['code-reviewer'] },
    { id: 'outreach', name: 'Sales & Outreach', reportsTo: 'ceo', manager: 'Head of Outreach', workers: ['outreach-writer'], reviewers: ['legal'] },
  ],
}
const CATALOG = { roles: {
  builder: { title: 'Software Engineer', agent: ['general-purpose'] },
  'outreach-writer': { title: 'Outreach Writer', agent: ['co-outreach-writer'] },
  'code-reviewer': { title: 'Code Reviewer', agent: ['ecc:code-reviewer', 'co-qa-reviewer'] },
  legal: { title: 'Legal Reviewer', agent: ['co-legal-counsel'] },
} }
const RUN = {
  id: '20261123-101500-ab12', status: 'executing', prompt: 'Build the API and draft cold emails', cost: 0.42,
  plan: { goal: 'API plus outreach drafts', questions: [] },
  tasks: [
    { id: 'T1', department: 'engineering', title: 'Build API', status: 'running', round: 0, workers: [
      { id: 'w1', agent: 'general-purpose', status: 'working' },
      // The plugin's namespaced copy of a bare catalog name still counts for that role.
      { id: 'w2', agent: 'company-hq:co-outreach-writer', status: 'working' },
    ] },
    { id: 'T2', department: 'outreach', title: 'Cold emails', status: 'approved', round: 1, workers: [] },
  ],
}
const EVENTS = [{ ts: '2026-11-23T10:16:00.000Z', type: 'worker.start', agent: 'general-purpose', description: 'implement endpoints' }]

// The bundled catalog is read from <plugin root>/engine/catalog.json; the root is wherever the test runs.
const BUNDLED_CATALOG = /\/engine\/catalog\.json$/

function disk(withTeam: boolean): Record<string, string> {
  if (!withTeam) return {}
  return {
    '/proj/.company/org.json': JSON.stringify(ORG),
    [`/proj/.company/runs/${RUN.id}/state.json`]: JSON.stringify(RUN),
    [`/proj/.company/runs/${RUN.id}/events.jsonl`]: EVENTS.map(e => JSON.stringify(e)).join('\n') + '\n',
  }
}

type Run = { argv: readonly string[]; stdin?: string }

function stubEngine(on: any, files: Record<string, string>, env: Record<string, string> = {}): Run[] {
  // The engine hands absolute host paths (C:\proj\...), so drop the drive and unify slashes.
  const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/[\\/]+/g, '/')
  const runs: Run[] = []
  on('clock.every', () => ({ value: {} }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? '/home' : env[e.name] }))
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('agent.report', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (BUNDLED_CATALOG.test(norm(e.path))) return { value: JSON.stringify(CATALOG) }
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.stat', (_: unknown, e: { path: string }) => {
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { size: text.length, kind: 'file', mtimeMs: 0 } }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    const dir = `${norm(e.path)}/`
    const names = [...new Set(Object.keys(files).filter(f => f.startsWith(dir)).map(f => f.slice(dir.length).split('/')[0]))]
    if (names.length === 0) throw new Error(`ENOENT ${e.path}`)
    const kindOf = (name: string) => (Object.keys(files).some(f => f.startsWith(`${dir}${name}/`)) ? 'dir' : 'file')
    return { value: names.map(name => ({ name, kind: kindOf(name), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('command.register', () => ({ value: { command: 'hq' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return runs
}

const delegationRuns = (runs: Run[]) => runs.filter(r => r.argv.some(a => a.endsWith('delegation-log.cjs')))

async function spawnAndReport($: any) {
  await $.agent.spawn({ prompt: 'write the API', description: 'implement endpoints', subagentType: 'company-hq:co-qa-reviewer' })
  await $.agent.report({ agentId: 'agent-1', subagentType: 'company-hq:co-qa-reviewer', status: 'completed', text: 'done', provider: 'plugin' })
}

const PANE = {
  plugin: 'company-hq', component: 'Pane', requestId: 'company-hq',
  props: { title: 'Claude HQ', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the overview says what is happening, with status, progress and controls (${surface})`, async ($, on) => {
    stubEngine(on, disk(true))
    await $.session.start({ cwd: '/proj', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    // Header: project, status pill, live numbers.
    expect(await ui.find({ type: 'Text', text: 'Acme' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: / WORKING / })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /agents working/ }))?.text).toContain('2 agents working')
    expect((await ui.find({ type: 'Text', text: /agents working/ }))?.text).toContain('1/2 tasks approved')
    // Overview says in words what is happening, and shows progress natively.
    expect((await ui.find({ type: 'Text', text: /is working on/ }))?.text).toBe('Engineering is working on “Build API” with 2 agents.')
    expect(await ui.find({ text: 'Tasks approved 1 of 2' })).toBeTruthy() // the Progress element's label and figure
    expect(await ui.find({ type: 'Input', key: 'ask' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeTruthy()
    await ui.unmount()
  })
}

test('the Team tab shows department cards with live workers under any agent namespace', async ($, on) => {
  stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Software Engineer ×1/ })).toBeFalsy()
  await ui.press({ key: 'tab-team' })
  expect(await ui.find({ type: 'Text', text: 'Engineering' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Software Engineer ×1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Outreach Writer ×1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Code Reviewer ×/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /⚖ Legal Reviewer/ })).toBeTruthy()
  await ui.unmount()
})

test('the Tasks and Activity tabs show task cards and every event', async ($, on) => {
  stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-tasks' })
  expect(await ui.find({ type: 'Text', text: / APPROVED / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Sales & Outreach · T2 · revision 1/ })).toBeTruthy()
  await ui.press({ key: 'tab-activity' })
  expect(await ui.find({ type: 'Text', text: 'general-purpose started: implement endpoints' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: / APPROVED / })).toBeFalsy()
  await ui.unmount()
})

test('typing a request into the pane starts a run through the bundled engine', async ($, on) => {
  const runs = stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'ask', text: 'Draft a launch email' })
  const engine = runs.find(r => r.argv.some(a => /engine[\\/]bin[\\/]hq\.js$/.test(a)))
  expect(engine?.argv[2]).toBe('run')
  expect(engine?.argv.at(-1)).toBe('Draft a launch email')
  await ui.unmount()
})

test('the band above the prompt shows status, progress and what is happening', async ($, on) => {
  stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'company-hq', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false } })
  expect(await ui.find({ type: 'Text', text: / WORKING / })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /▰/ }))?.text).toContain('1/2')
  expect(await ui.find({ type: 'Text', text: /Engineering is working on/ })).toBeTruthy()
  await ui.unmount()
})

test('a run stopped by the usage limit says so in plain words, with the reset time', async ($, on) => {
  const limited = {
    ...RUN, status: 'done_with_failures',
    tasks: RUN.tasks.map(t => ({ ...t, status: 'failed', workers: [], error: "You've hit your 5-hour limit · resets 10:10pm (America/Chicago)" })),
  }
  const files = { ...disk(true), [`/proj/.company/runs/${RUN.id}/state.json`]: JSON.stringify(limited) }
  stubEngine(on, files)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /usage limit/ }))?.text)
    .toBe('Paused by your Claude usage limit, which resets 10:10pm (America/Chicago). Run the request again after that.')
  expect(await ui.find({ type: 'Text', text: / DONE WITH ISSUES / })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeFalsy()
  await ui.unmount()
})

test('a project without a team offers to hire one and shows no band', async ($, on) => {
  stubEngine(on, disk(false))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Button', key: 'hire' })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'stop' })).toBeFalsy()
  await pane.unmount()
})

test('a chat spawn logged twice (old settings hook plus the mod) shows once', async ($, on) => {
  const now = new Date().toISOString()
  const spawn = { ts: now, source: 'interactive', type: 'worker.start', toolUseId: 'toolu_1', agent: 'co-copywriter', description: 'draft hero copy' }
  const other = { ...spawn, toolUseId: 'toolu_2', description: 'draft pricing copy' }
  const files = { ...disk(true), '/proj/.company/events.jsonl': [spawn, spawn, other].map(e => JSON.stringify(e)).join('\n') + '\n' }
  stubEngine(on, files)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-activity' })
  expect(await ui.findAll({ type: 'Text', text: 'co-copywriter started: draft hero copy' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: 'co-copywriter started: draft pricing copy' })).toHaveLength(1)
  await ui.unmount()
})

test('/hq run calls the engine bundled inside the plugin', async ($, on) => {
  const runs = stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'hq', args: 'run draft a launch post' } as any)
  const engine = runs.find(r => r.argv.some(a => /engine[\\/]bin[\\/]hq\.js$/.test(a)))
  expect(engine).toBeTruthy()
  expect(engine?.argv[0]).toBe('node')
  expect(engine?.argv[2]).toBe('run')
  expect(engine?.argv.at(-1)).toBe('draft a launch post')
  expect(runs.some(r => r.argv.some(a => a.includes('.claude/company/hq')))).toBe(false)
})

test('a subagent spawned from the chat is logged as a start and a finish', async ($, on) => {
  const runs = stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await spawnAndReport($)
  const logged = delegationRuns(runs).map(r => JSON.parse(r.stdin ?? '{}'))
  expect(logged.map(l => l.hook_event_name)).toEqual(['PreToolUse', 'PostToolUse'])
  expect(logged[0].tool_input.subagent_type).toBe('company-hq:co-qa-reviewer')
  expect(logged[1].tool_response.is_error).toBe(false)
})

test("a headless session (the engine's own processes) logs no chat delegation", async ($, on) => {
  const runs = stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
  await spawnAndReport($)
  expect(delegationRuns(runs)).toHaveLength(0)
})

test('a session started by an HQ run logs no chat delegation', async ($, on) => {
  const runs = stubEngine(on, disk(true), { HQ_RUN_ID: '20261123-101500-ab12' })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await spawnAndReport($)
  expect(delegationRuns(runs)).toHaveLength(0)
})

test('a project without a team logs no chat delegation', async ($, on) => {
  const runs = stubEngine(on, disk(false))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await spawnAndReport($)
  expect(delegationRuns(runs)).toHaveLength(0)
})

// ---------- seeing what HQ is doing ----------

/** The project's files with this run as its only run, its events, and any extra files (slots). */
function withRun(state: object, events: object[], extra: Record<string, string> = {}): Record<string, string> {
  return {
    '/proj/.company/org.json': JSON.stringify(ORG),
    [`/proj/.company/runs/${RUN.id}/state.json`]: JSON.stringify({ ...RUN, ...state }),
    [`/proj/.company/runs/${RUN.id}/events.jsonl`]: events.map(e => JSON.stringify(e)).join('\n') + '\n',
    ...extra,
  }
}

const now = () => new Date().toISOString()
const slot = (s: object) => JSON.stringify({ pid: 1, ts: Date.now() - 90_000, ...s })

test('a queued run says what is holding the Claude slots, even in another project', async ($, on) => {
  const files = withRun({ status: 'queued', tasks: [], plan: undefined }, [{ ts: now(), type: 'slot.wait', label: 'CEO · plan', freeMB: 1500 }], {
    '/home/.claude/company/state/slots/1-a': slot({ label: 'Review · web-client', project: 'MICA', runId: 'other-run' }),
    '/home/.claude/company/state/slots/1-b': slot({ label: 'Backend · T3', project: 'MICA', runId: 'other-run' }),
  })
  stubEngine(on, files)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Queued/ }))?.text).toBe('Queued: every Claude slot is busy. Running now: Review · web-client (MICA); Backend · T3 (MICA).')
  expect(await ui.find({ type: 'Text', text: 'Slots taken by other work:' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /2\/2 in use/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeTruthy()
  await ui.unmount()
})

test('a run with free slots says it starts as soon as one is free, and lists no other work', async ($, on) => {
  stubEngine(on, withRun({ status: 'queued', tasks: [], plan: undefined }, [{ ts: now(), type: 'run.queued' }]))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Queued: starting as soon as a Claude slot is free.' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Slots taken by other work:' })).toBeFalsy()
  await ui.unmount()
})

test('planning shows the CEO process live, with a timer and a moving bar', async ($, on) => {
  const files = withRun({ status: 'planning', tasks: [], plan: undefined, startedAt: now() }, [{ ts: now(), type: 'process.start', label: 'CEO · plan' }], {
    '/home/.claude/company/state/slots/1-a': slot({ label: 'CEO · plan', project: 'Acme', runId: RUN.id }),
  })
  stubEngine(on, files)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / PLANNING / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'The CEO is reading the project and splitting the request into tasks.' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'CEO · plan' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /━●━/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Slots taken by other work:' })).toBeFalsy()
  await ui.unmount()
})

test('a paused run offers Resume, which carries it on through the engine', async ($, on) => {
  const files = withRun({ status: 'paused', resets: '4:20pm (America/Chicago)', tasks: RUN.tasks.map(t => ({ ...t, workers: [], status: t.id === 'T1' ? 'pending' : 'approved' })) },
    [{ ts: now(), type: 'run.paused', resets: '4:20pm (America/Chicago)' }])
  const runs = stubEngine(on, files)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: / PAUSED / })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /usage limit/ }))?.text).toContain('resets 4:20pm (America/Chicago)')
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeFalsy()
  await ui.press({ key: 'resume' })
  const resume = runs.find(r => r.argv.includes('resume'))
  expect(resume?.argv.at(-1)).toBe(RUN.id)
  await ui.unmount()
})

test('an active run offers no Resume button', async ($, on) => {
  stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'resume' })).toBeFalsy()
  await ui.unmount()
})

test('a task approved with open review issues is flagged, and its details open on click', async ($, on) => {
  const tasks = [{ id: 'T1', department: 'engineering', title: 'Legacy guard', status: 'approved', round: 1, unresolvedReview: true, workers: [],
    brief: 'Guard the legacy routes', verdict: { verdict: 'revise', score: 6, summary: 'still leaky', issues: ['PHI in logs', 'no rate limit'] } }]
  stubEngine(on, withRun({ status: 'done_with_failures', tasks }, [{ ts: now(), type: 'run.end', status: 'done_with_failures' }]))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-tasks' })
  expect(await ui.find({ type: 'Text', text: / APPROVED ⚠ / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /reviewers still had open issues/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Open issues' })).toBeFalsy()
  await ui.press({ key: 'task-T1' })
  expect(await ui.find({ type: 'Text', text: 'Open issues' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '1. PHI in logs' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Guard the legacy routes' })).toBeTruthy()
  await ui.unmount()
})
