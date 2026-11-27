import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportRunToObsidian, backfillObsidian, obsidianDir, runNoteName, safeName } from '../src/obsidian.js';

/** A project in a folder named `name`; its org calls it something longer, as real teams do. */
function project(name = 'Acme') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hqobs-')), name);
  fs.mkdirSync(path.join(dir, '.company', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.company', 'org.json'), JSON.stringify({
    project: { name: `${name} (display name)`, type: 'startup' }, executives: [{ id: 'ceo', title: 'CEO' }],
    departments: [{ id: 'web', name: 'Web & Landing Pages', workers: ['copywriter'], reviewers: ['legal'] }],
  }));
  return dir;
}

function saveRun(dir, state) {
  const runDir = path.join(dir, '.company', 'runs', state.id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state));
  return state;
}

const PAUSED = {
  id: '20261124-140738-2966', status: 'paused', prompt: 'Build the landing page | and pricing', cost: 1.5,
  createdAt: '2026-11-24T14:07:38.000Z', resets: '4:20pm (America/Chicago)',
  plan: { goal: 'Ship the page', doneMeans: 'live draft', questions: ['Which plan tier?'] },
  tasks: [
    { id: 'T1', department: 'web', title: 'Hero copy', status: 'approved', verdict: { verdict: 'approve', score: 9, summary: 'good' } },
    { id: 'T2', department: 'web', title: 'Pricing table', status: 'pending' },
  ],
};

test('a run becomes a linked note, with a project index and a dashboard', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const proj = project();
  saveRun(proj, PAUSED);
  const config = { obsidian: { vault, folder: 'Second Brain/HQ' } };
  const file = exportRunToObsidian(proj, PAUSED, config);
  assert.ok(file.startsWith(path.join(vault, 'Second Brain', 'HQ', 'Acme')));
  const note = fs.readFileSync(file, 'utf8');
  assert.match(note, /^---\ntype: hq-run\nproject: "Acme"/);
  assert.match(note, /status: paused/);
  assert.match(note, /\[\[Acme\]\]/, 'links the project note');
  assert.match(note, /\[\[Acme HQ\]\]/, 'links the project index');
  assert.match(note, /\[!warning\] Paused by the Claude usage limit, which resets 4:20pm \(America\/Chicago\)/);
  assert.match(note, /\| T1 \| Hero copy \| Web & Landing Pages \| approved \| approve 9\/10 \|/);
  assert.match(note, /Which plan tier\?/);
  const index = fs.readFileSync(path.join(vault, 'Second Brain', 'HQ', 'Acme', 'Acme HQ.md'), 'utf8');
  assert.ok(index.includes(`[[${runNoteName(PAUSED)}]]`), 'the index links the run note');
  assert.match(fs.readFileSync(path.join(vault, 'Second Brain', 'HQ', 'HQ.md'), 'utf8'), /\[\[Acme HQ\]\]/);

  // Re-exporting the finished run rewrites the same note instead of adding another.
  const done = saveRun(proj, { ...PAUSED, status: 'done', board: { decision: 'approve', summary: 'ship it' } });
  assert.equal(exportRunToObsidian(proj, done, config), file);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f !== 'Acme HQ.md').length, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /\[!success\] Done\. The Board said \*\*approve\*\*/);
});

test('nothing is written when Obsidian is not configured, the vault is missing, or the folder leaves the vault', () => {
  const proj = project();
  saveRun(proj, PAUSED);
  assert.equal(exportRunToObsidian(proj, PAUSED, {}), null);
  assert.equal(exportRunToObsidian(proj, PAUSED, { obsidian: { vault: path.join(os.tmpdir(), 'no-such-vault-xyz') } }), null);
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  assert.equal(obsidianDir({ obsidian: { vault, folder: '../outside' } }), null);
  // A sibling folder that shares the vault's name as a prefix is still outside it.
  assert.equal(obsidianDir({ obsidian: { vault, folder: `../${path.basename(vault)}2` } }), null);
  assert.equal(obsidianDir({ obsidian: { vault, folder: 'Notes/HQ' } }), path.join(vault, 'Notes', 'HQ'));
  assert.equal(backfillObsidian(proj, {}), 0);
});

test('backfill exports every run of a project', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const proj = project('Beta');
  saveRun(proj, PAUSED);
  saveRun(proj, { ...PAUSED, id: '20261123-235745-9428', createdAt: '2026-11-23T23:57:45.000Z', prompt: 'continue working', status: 'done_with_failures' });
  assert.equal(backfillObsidian(proj, { obsidian: { vault } }), 2);
  const index = fs.readFileSync(path.join(vault, 'HQ', 'Beta', 'Beta HQ.md'), 'utf8');
  assert.equal((index.match(/\[\[2026-11-2/g) || []).length, 2);
});

test('two runs started in the same minute with the same words get different notes', () => {
  const a = runNoteName({ ...PAUSED, id: '20261124-140738-aaaa' });
  const b = runNoteName({ ...PAUSED, id: '20261124-140751-bbbb' });
  assert.notEqual(a, b);
  assert.match(a, /\(aaaa\)$/);
});

test('names are safe for every OS and for wiki links', () => {
  assert.equal(safeName('a/b\\c:d*e?"f<g>h|i#j^k[l]m'), 'a b c d e f g h i j k l m');
  assert.ok(!/[\\/:*?"<>|#^[\]]/.test(runNoteName(PAUSED)));
});
