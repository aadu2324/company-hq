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
  builder: { title: 'Software Engineer', agent: 'general-purpose' },
  'outreach-writer': { title: 'Outreach Writer', agent: 'co-outreach-writer' },
  'code-reviewer': { title: 'Code Reviewer', agent: 'ecc:code-reviewer' },
  legal: { title: 'Legal Reviewer', agent: 'co-legal-counsel' },
} }
const RUN = {
  id: '20261123-101500-ab12', status: 'executing', prompt: 'Build the API and draft cold emails', cost: 0.42,
  plan: { goal: 'API plus outreach drafts', questions: [] },
  tasks: [
    { id: 'T1', department: 'engineering', title: 'Build API', status: 'running', round: 0, workers: [{ id: 'w1', agent: 'general-purpose', status: 'working' }] },
    { id: 'T2', department: 'outreach', title: 'Cold emails', status: 'approved', round: 1, workers: [] },
  ],
}
const EVENTS = [{ ts: '2026-11-23T10:16:00.000Z', type: 'worker.start', agent: 'general-purpose', description: 'implement endpoints' }]

function disk(withTeam: boolean): Record<string, string> {
  const files: Record<string, string> = { '/home/.claude/company/catalog.json': JSON.stringify(CATALOG) }
  if (!withTeam) return files
  return {
    ...files,
    '/proj/.company/org.json': JSON.stringify(ORG),
    [`/proj/.company/runs/${RUN.id}/state.json`]: JSON.stringify(RUN),
    [`/proj/.company/runs/${RUN.id}/events.jsonl`]: EVENTS.map(e => JSON.stringify(e)).join('\n') + '\n',
  }
}

function stubEngine(on: any, files: Record<string, string>) {
  // The engine hands absolute host paths (C:\proj\...), so drop the drive and unify slashes.
  const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/[\\/]+/g, '/')
  on('clock.every', () => ({ value: {} }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? '/home' : undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => {
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
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('command.register', () => ({ value: { command: 'hq' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

const PANE = {
  plugin: 'company-hq', component: 'Pane', requestId: 'company-hq',
  props: { title: 'Claude HQ', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane shows the org chart with live workers and the run tasks', async ($, on) => {
  stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Acme · startup · 1 active run/ }))?.text).toContain('1 agent(s) working')
    expect(await ui.find({ type: 'Text', text: /● Engineering — Eng Manager/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /● Software Engineer ×1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /review: Legal Reviewer/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /T2 outreach: Cold emails r1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /→ general-purpose: implement endpoints/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', label: 'Stop run' })).toBeTruthy()
    await ui.unmount()
  }
})

test('the band above the prompt summarises the active run', async ($, on) => {
  stubEngine(on, disk(true))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'company-hq', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false } })
  expect((await ui.find({ type: 'Text', text: /HQ · Acme/ }))?.text).toContain('executing 1/2 tasks')
  await ui.unmount()
})

test('a project without a team offers to hire one and shows no band', async ($, on) => {
  stubEngine(on, disk(false))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Button', label: 'Hire a team' })).toBeTruthy()
  await pane.unmount()
})
