import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBibtex, jsonBlocks, fileDeliverable, knowledgeDirs } from '../src/knowledge.js';
import { addTopics, loadWatch, parseArxivAtom, runWatch, gapsTouched, watchCommand } from '../src/watch.js';

const fence = (tag, body) => ['```' + tag, body, '```'].join('\n');

const DELIVERABLE = [
  '# Gap report',
  'Some findings.',
  fence('bibtex', [
    '@article{smith2025, title = {Sparse {Attention} for Long Proofs}, author = {Smith, A. and Lee, B.}, year = {2025}, eprint = {2501.01234}}',
    '@inproceedings{doe2024, title = "Verified Lemma Search", author = {Doe, J.}, year = 2024, url = {https://example.org/vls}}',
  ].join('\n')),
  fence('hq-gaps', JSON.stringify([{ title: 'Formal proofs for sparse attention bounds', field: 'Formal Methods', kind: 'research',
    summary: 'No machine-checked proofs exist for sparse attention approximation bounds.', evidence: ['https://example.org/vls'],
    impact: 4, tractability: 3, verifiability: 5 }])),
  fence('hq-watch', JSON.stringify([{ field: 'Formal Methods', arxiv: 'abs:"sparse attention" AND abs:proof', hn: 'lean theorem prover' }])),
  fence('hq-gaps', '{ not json'),
].join('\n\n');

function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  return { dir, config: { obsidian: { vault: dir, knowledgeFolder: 'Second Brain' } } };
}

test('BibTeX entries are read with braces, quotes and bare numbers', () => {
  const entries = parseBibtex(fence('', DELIVERABLE));
  assert.deepEqual(entries.map((e) => [e.key, e.title, e.year]), [
    ['smith2025', 'Sparse Attention for Long Proofs', '2025'],
    ['doe2024', 'Verified Lemma Search', '2024'],
  ]);
  assert.equal(entries[0].eprint, '2501.01234');
});

test('invalid JSON blocks are skipped, valid ones kept', () => {
  assert.equal(jsonBlocks(DELIVERABLE, 'hq-gaps').length, 1);
  assert.equal(jsonBlocks(DELIVERABLE, 'hq-watch')[0].field, 'Formal Methods');
});

test('a deliverable files papers, gaps and a field hub into the vault, and never overwrites a note', () => {
  const { dir, config } = vault();
  const found = fileDeliverable(DELIVERABLE, { project: 'Prover', run: '2026-11-26 0900 find gaps (abcd)', config });
  assert.deepEqual([found.papers, found.gaps, found.topics.length], [2, 1, 1]);
  const lit = path.join(dir, 'Second Brain', 'Literature', 'Formal Methods', '2025 Sparse Attention for Long Proofs.md');
  assert.match(fs.readFileSync(lit, 'utf8'), /type: literature[\s\S]*Link:\*\* https:\/\/arxiv\.org\/abs\/2501\.01234/);
  assert.match(fs.readFileSync(lit, 'utf8'), /\[\[Formal Methods\]\] · Found for: \[\[Prover\]\]/);
  const gap = path.join(dir, 'Second Brain', 'Gaps', 'Formal Methods', 'Formal proofs for sparse attention bounds.md');
  assert.match(fs.readFileSync(gap, 'utf8'), /kind: "research"[\s\S]*Verifiability\*\* 5\/5/);
  const hub = fs.readFileSync(path.join(dir, 'Second Brain', 'Fields', 'Formal Methods.md'), 'utf8');
  assert.match(hub, /Open gaps and opportunities \(1\)/);
  assert.match(hub, /Literature \(2\)/);

  fs.appendFileSync(lit, 'My own note on this paper.\n');
  fileDeliverable(DELIVERABLE, { project: 'Prover', config });
  assert.match(fs.readFileSync(lit, 'utf8'), /My own note on this paper\./, 'the owner annotation survives');
});

test('nothing is written without a vault, and the knowledge folder cannot leave it', () => {
  assert.equal(fileDeliverable(DELIVERABLE, { config: {} }).papers, 0);
  const { config } = vault();
  assert.equal(knowledgeDirs({ obsidian: { ...config.obsidian, knowledgeFolder: '../elsewhere' } }), null);
});

const ATOM = `<?xml version="1.0"?><feed>
<entry><id>http://arxiv.org/abs/2511.11111v1</id><published>2026-11-25T10:00:00Z</published>
<title>Machine-checked bounds for sparse attention approximation</title>
<summary>We give formal proofs of sparse attention approximation bounds in Lean, closing a gap.</summary>
<author><name>Ada Lovelace</name></author><author><name>Alan Turing</name></author></entry>
<entry><id>http://arxiv.org/abs/2511.22222v1</id><published>2026-11-25T11:00:00Z</published>
<title>Unrelated &amp; different topic</title><summary>Birds migrate.</summary><author><name>X Y</name></author></entry>
<entry><id>http://arxiv.org/abs/2401.00001v1</id><published>2024-01-01T00:00:00Z</published>
<title>Old paper</title><summary>old</summary><author><name>Old</name></author></entry>
</feed>`;

const HN = JSON.stringify({ hits: [{ objectID: '1', title: 'Lean 4 hits 1.0', url: 'https://example.org/lean', points: 120, num_comments: 40 }] });

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url.includes('arxiv.org')) return { ok: true, text: async () => ATOM };
    if (url.includes('hn.algolia.com')) return { ok: true, text: async () => HN };
    return { ok: false, status: 404, text: async () => '' };
  };
}

test('arXiv entries are parsed with ids, dates and authors', () => {
  const papers = parseArxivAtom(ATOM);
  assert.equal(papers.length, 3);
  assert.equal(papers[0].eprint, '2511.11111');
  assert.equal(papers[0].authors, 'Ada Lovelace, Alan Turing');
  assert.equal(papers[1].title, 'Unrelated & different topic');
});

test('the watch files new papers, flags the gap they touch, lists HN stories, and does not repeat itself', async () => {
  const { dir, config } = vault();
  fileDeliverable(DELIVERABLE, { project: 'Prover', config });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watch.json');
  addTopics([{ field: 'Formal Methods', arxiv: 'abs:proof', hn: 'lean' }], file);
  const calls = [];
  const now = new Date('2026-11-26T08:00:00Z');
  const first = await runWatch({ fetchFn: fakeFetch(calls), now, config, file, pauseMs: 0 });
  assert.equal(first.papers, 2, 'the 2024 paper is older than the first look-back');
  assert.equal(first.flagged, 1);
  const digest = fs.readFileSync(first.digest, 'utf8');
  assert.match(digest, /may affect \[\[Formal proofs for sparse attention bounds\]\]/);
  assert.match(digest, /\[Lean 4 hits 1\.0\]\(https:\/\/example\.org\/lean\) · 120 points/);
  assert.ok(fs.existsSync(path.join(dir, 'Second Brain', 'Literature', 'Formal Methods', '2026 Machine-checked bounds for sparse attention approximation.md')));
  assert.ok(fs.existsSync(path.join(dir, 'Second Brain', 'Research Watch', 'Research Watch.md')));
  assert.ok(calls.length > 0 && calls.every((u) => /^https:\/\/(export\.arxiv\.org|hn\.algolia\.com)\//.test(u)), 'only the two public APIs are called');

  const second = await runWatch({ fetchFn: fakeFetch([]), now: new Date('2026-11-27T08:00:00Z'), config, file, pauseMs: 0 });
  assert.equal(second.papers, 0, 'papers already seen are not filed again');
});

test('a paper submitted before the last check but announced after it is still filed', async () => {
  const { config } = vault();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watch.json');
  addTopics([{ field: 'Formal Methods', arxiv: 'abs:proof' }], file);
  const empty = '<?xml version="1.0"?><feed></feed>';
  await runWatch({ fetchFn: async () => ({ ok: true, text: async () => empty }), now: new Date('2026-11-25T12:00:00Z'), config, file, pauseMs: 0 });
  // Submitted 10:00 on the 25th (before that noon check), announced on the 26th.
  const late = await runWatch({ fetchFn: fakeFetch([]), now: new Date('2026-11-26T08:00:00Z'), config, file, pauseMs: 0 });
  assert.equal(late.papers, 2);
});

test('a second check on the same day keeps the morning digest and appends only news', async () => {
  const { config } = vault();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watch.json');
  addTopics([{ field: 'Formal Methods', arxiv: 'abs:proof' }], file);
  const morning = new Date(2026, 10, 26, 8, 0);
  const first = await runWatch({ fetchFn: fakeFetch([]), now: morning, config, file, pauseMs: 0 });
  const before = fs.readFileSync(first.digest, 'utf8');
  assert.match(before, /Machine-checked bounds/);
  await runWatch({ fetchFn: fakeFetch([]), now: new Date(2026, 10, 26, 13, 0), config, file, pauseMs: 0 });
  assert.equal(fs.readFileSync(first.digest, 'utf8'), before, 'nothing new: the digest is untouched');
  const newer = ATOM.replace('2511.11111', '2511.33333').replace('Machine-checked bounds', 'Fresh result on').replace('2026-11-25T10', '2026-11-26T12');
  const fetchNewer = async (url) => ({ ok: true, text: async () => (url.includes('arxiv') ? newer : HN) });
  await runWatch({ fetchFn: fetchNewer, now: new Date(2026, 10, 26, 18, 30), config, file, pauseMs: 0 });
  const after = fs.readFileSync(first.digest, 'utf8');
  assert.ok(after.startsWith(before), 'the morning list is kept');
  assert.match(after, /# Update 18:30[\s\S]*Fresh result on/);
});

test('one field failing does not stop the others', async () => {
  const { config } = vault();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watch.json');
  addTopics([{ field: 'Broken', arxiv: 'x' }, { field: 'Working', hn: 'lean' }], file);
  const fetchFn = async (url) => (url.includes('arxiv') ? { ok: false, status: 503, text: async () => '' } : { ok: true, text: async () => HN });
  const r = await runWatch({ fetchFn, config, file, pauseMs: 0 });
  assert.equal(r.fields, 2);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Broken: .*503/);
  assert.ok(loadWatch(file).topics.find((t) => t.field === 'Working').lastChecked);
  assert.equal(loadWatch(file).topics.find((t) => t.field === 'Broken').lastChecked, null, 'a failed field is retried next time');
});

test('names that mean something to the file system stay ordinary names', async () => {
  const { safeName } = await import('../src/obsidian.js');
  assert.equal(safeName('..'), '', 'a dots-only name is no name');
  assert.equal(safeName('.'), '');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.txt'), '_nul.txt');
  assert.equal(safeName('Console tricks'), 'Console tricks');
  assert.equal(safeName('ends with dots...'), 'ends with dots');
  const { dir, config } = vault();
  fileDeliverable(fence('hq-gaps', JSON.stringify([{ title: 'x', field: '..' }])), { config });
  assert.ok(fs.existsSync(path.join(dir, 'Second Brain', 'Gaps', 'General', 'x.md')), 'a ".." field files under General, not above Gaps');
  assert.ok(!fs.existsSync(path.join(dir, 'Second Brain', 'x.md')));
});

test('a hand-edited watch list with broken entries still works, and a field added mid-check survives', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watch.json');
  fs.writeFileSync(file, JSON.stringify({ topics: [{ arxiv: 'no field' }, null, { field: 'Kept', hn: 'x', seen: [] }] }));
  assert.deepEqual(loadWatch(file).topics.map((t) => t.field), ['Kept']);
  const { config } = vault();
  const fetchFn = async (url) => {
    addTopics([{ field: 'Added during the check', hn: 'y' }], file); // a run filing a new field meanwhile
    return { ok: true, text: async () => (url.includes('arxiv') ? ATOM : HN) };
  };
  await runWatch({ fetchFn, config, file, pauseMs: 0 });
  assert.deepEqual(loadWatch(file).topics.map((t) => t.field).sort(), ['Added during the check', 'Kept']);
});

test('fields are tracked once each, and gap matching needs shared distinctive words', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watch.json');
  assert.equal(addTopics([{ field: 'Formal Methods', arxiv: 'a' }, { field: 'formal methods', arxiv: 'b' }, { field: 'No query' }], file), 1);
  assert.equal(loadWatch(file).topics[0].arxiv, 'b');
  const gaps = [{ name: 'g', words: new Set(['sparse', 'attention', 'bounds', 'formal']) }];
  assert.deepEqual(gapsTouched({ title: 'Formal sparse attention bounds', abstract: '' }, gaps), ['g']);
  assert.deepEqual(gapsTouched({ title: 'Sparse birds', abstract: '' }, gaps), []);
  assert.ok(watchCommand({ watch: { launcher: ['pythonw', 'hide.py'] } }).join(' ').startsWith('pythonw hide.py '));
});
