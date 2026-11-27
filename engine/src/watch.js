/**
 * The research watch: once a day, what is new in every field HQ has worked in.
 *
 * Fields come from runs (gap analysts end their reports with an hq-watch block) or `hq watch add`.
 * For each field it asks arXiv for new papers and Hacker News for new stories, files new papers as
 * Literature notes, flags papers that may close one of the owner's open gaps, and writes a dated digest
 * into the vault. It only reads public APIs (no Claude, so no usage) and sends nothing but the field's
 * search terms.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPANY_DIR, ENGINE_DIR, loadConfig } from './config.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { knowledgeDirs, filePaper, writeFieldHub, paperNoteName } from './knowledge.js';
import { safeName } from './obsidian.js';

export const WATCH_FILE = path.join(COMPANY_DIR, 'watch.json');
const ARXIV = 'https://export.arxiv.org/api/query';
const HN = 'https://hn.algolia.com/api/v1/search_by_date';
const PER_QUERY = 25;
const ARXIV_PAUSE_MS = 3000; // arXiv asks for at most one request every 3 seconds
const MAX_SEEN = 400;
const FETCH_TIMEOUT_MS = 30_000;
const FIRST_LOOKBACK_DAYS = 14;
const MATCH_WORDS = 3;
const USER_AGENT = 'company-hq-watch (+https://github.com/aadu2324/company-hq)';
const STOP = new Set('about after again against among based between both could during each either from have into itself more most other over same should since some such than that their them then there these they this those through under using very what when where which while with within without would your'.split(' '));

// ---------- tracked fields ----------

export function loadWatch(file = WATCH_FILE) {
  const w = readJson(file, null);
  // A hand-edited file may hold entries without a field; they are ignored rather than crashing every command.
  return { topics: Array.isArray(w?.topics) ? w.topics.filter((t) => t && typeof t.field === 'string' && t.field.trim()) : [] };
}

/** Adds fields to watch, keeping one entry per field (the newest queries win). Returns how many were new. */
export function addTopics(topics, file = WATCH_FILE) {
  const watch = loadWatch(file);
  let added = 0;
  for (const t of topics) {
    const field = safeName(t.field);
    if (!field || !(t.arxiv || t.hn)) continue;
    const old = watch.topics.find((x) => x.field.toLowerCase() === field.toLowerCase());
    if (old) {
      old.arxiv = String(t.arxiv || old.arxiv || '');
      old.hn = String(t.hn || old.hn || '');
    } else {
      watch.topics.push({ field, arxiv: String(t.arxiv || ''), hn: String(t.hn || ''), addedAt: new Date().toISOString(), lastChecked: null, seen: [] });
      added += 1;
    }
  }
  writeJsonAtomic(file, watch);
  return added;
}

// ---------- sources ----------

const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]);

/** Papers from an arXiv Atom feed. */
export function parseArxivAtom(xml) {
  return [...String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const id = tag(e, 'id');
    return {
      id,
      eprint: id.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, ''),
      title: tag(e, 'title'),
      abstract: tag(e, 'summary'),
      published: tag(e, 'published'),
      year: tag(e, 'published').slice(0, 4),
      authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => decode(a[1])).join(', '),
      // The canonical, version-free https link, so one paper always has one link.
      url: `https://arxiv.org/abs/${id.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '')}`,
    };
  }).filter((p) => p.id && p.title);
}

async function fetchText(fetchFn, url) {
  // A stalled connection must not hang the daily task (and every later day's, which Task Scheduler then skips).
  const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
}

/**
 * Papers not filed before. arXiv's "published" is the submission time and papers are announced hours
 * later, so filtering by the last check would miss some: the seen list prevents repeats, and a fixed
 * look-back window only keeps very old papers out.
 */
async function newPapers(fetchFn, topic, now) {
  const q = new URLSearchParams({ search_query: topic.arxiv, sortBy: 'submittedDate', sortOrder: 'descending', max_results: String(PER_QUERY) });
  const since = now.getTime() - FIRST_LOOKBACK_DAYS * 86400000;
  const seen = new Set(topic.seen || []);
  return parseArxivAtom(await fetchText(fetchFn, `${ARXIV}?${q}`))
    .filter((p) => !seen.has(p.eprint) && (Date.parse(p.published) || 0) >= since);
}

async function newStories(fetchFn, topic) {
  const since = Math.floor((Date.parse(topic.lastChecked || '') || Date.now() - FIRST_LOOKBACK_DAYS * 86400000) / 1000);
  const q = new URLSearchParams({ query: topic.hn, tags: 'story', numericFilters: `created_at_i>${since}`, hitsPerPage: '20' });
  const data = JSON.parse(await fetchText(fetchFn, `${HN}?${q}`));
  return (data.hits || []).map((h) => ({
    title: String(h.title || ''), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    points: Number(h.points) || 0, comments: Number(h.num_comments) || 0,
  })).filter((s) => s.title);
}

// ---------- gaps a paper may close ----------

const words = (text) => new Set(String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)?.filter((w) => !STOP.has(w)) || []);

/** The owner's open gaps in a field, as { name, words }. */
function openGaps(dirs, field) {
  const dir = path.join(dirs.gaps, safeName(field));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  return files.flatMap((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/^status:\s*"?(closed|done|solved)/m.test(text)) return [];
    return [{ name: f.slice(0, -3), words: words(text.replace(/^---[\s\S]*?---/, '')) }];
  });
}

/** Gaps sharing enough distinctive words with a paper to be worth a look. */
export function gapsTouched(paper, gaps, threshold = MATCH_WORDS) {
  const pw = words(`${paper.title} ${paper.abstract}`);
  return gaps.filter((g) => [...g.words].filter((w) => pw.has(w)).length >= threshold).map((g) => g.name);
}

// ---------- the run ----------

/** The owner's calendar date (local time), so a digest is named for the day it was read. */
const pad2 = (n) => String(n).padStart(2, '0');
export const localDate = (now = new Date()) => `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const today = (now) => localDate(now);

/** Text that stays on one Markdown line. */
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** A URL that cannot end a Markdown link early. */
const linkSafe = (u) => String(u || '').replace(/[\s()<>]/g, (c) => encodeURIComponent(c));

function digestNote(date, sections) {
  const body = sections.map((s) => `## ${s.field}

${s.error ? `> [!warning] ${oneLine(s.error)}\n\n` : ''}${s.papers.length ? `### New papers (${s.papers.length})\n${s.papers.map((p) => `- [[${p.note}]]${p.touches.length ? ` · may affect ${p.touches.map((g) => `[[${g}]]`).join(', ')}` : ''}`).join('\n')}\n` : 'No new papers.\n'}
${s.stories.length ? `### On Hacker News\n${s.stories.map((st) => `- [${oneLine(st.title).replace(/[[\]]/g, '')}](${linkSafe(st.url)}) · ${st.points} points, ${st.comments} comments`).join('\n')}\n` : ''}`).join('\n');
  const flagged = sections.flatMap((s) => s.papers.filter((p) => p.touches.length)).length;
  return `---
type: research-watch
date: ${JSON.stringify(date)}
papers: ${sections.reduce((n, s) => n + s.papers.length, 0)}
flagged: ${flagged}
tags: [research-watch]
---
<!-- written by company-hq watch -->

# Research watch ${date}

${flagged ? `> [!important] ${flagged} new paper(s) may affect one of your open gaps. Check them before building on that gap.\n\n` : ''}${body}`;
}

function writeWatchIndex(dirs) {
  const days = fs.readdirSync(dirs.watch).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, -3)).sort().reverse();
  fs.writeFileSync(path.join(dirs.watch, 'Research Watch.md'), `---
type: research-watch-index
tags: [research-watch]
---
<!-- written by company-hq watch -->

# Research Watch

What is new in the fields HQ tracks, newest first. Fields: \`hq watch list\`; add one: \`hq watch add "<field>" --arxiv "<query>"\`.

${days.map((d) => `- [[${d}]]`).join('\n')}
`);
}

/**
 * Checks every tracked field once. `fetchFn` and `pauseMs` exist for tests. Returns a summary.
 * Never throws for one field's failure: the field's section in the digest says what went wrong.
 */
export async function runWatch({ fetchFn = globalThis.fetch, now = new Date(), config = loadConfig(), file = WATCH_FILE, pauseMs = ARXIV_PAUSE_MS } = {}) {
  const dirs = knowledgeDirs(config);
  const watch = loadWatch(file);
  if (!watch.topics.length) return { fields: 0, papers: 0, flagged: 0, digest: null };
  const sections = [];
  let first = true;
  for (const topic of watch.topics) {
    const section = { field: topic.field, papers: [], stories: [], error: '' };
    try {
      if (topic.arxiv) {
        if (!first) await new Promise((r) => setTimeout(r, pauseMs));
        first = false;
        const gaps = dirs ? openGaps(dirs, topic.field) : [];
        for (const p of await newPapers(fetchFn, topic, now)) {
          const note = dirs ? filePaper(dirs, p, { field: topic.field, source: 'arXiv watch' }) : paperNoteName(p);
          section.papers.push({ note, touches: gapsTouched(p, gaps) });
          topic.seen = [p.eprint, ...(topic.seen || [])].slice(0, MAX_SEEN);
        }
      }
      if (topic.hn) section.stories = await newStories(fetchFn, topic);
      topic.lastChecked = now.toISOString();
    } catch (err) {
      section.error = `Could not check this field: ${err.message}`;
    }
    if (dirs) writeFieldHub(dirs, topic.field);
    sections.push(section);
  }
  // Runs may have added fields while this check was going: merge them in rather than writing over them.
  const current = loadWatch(file).topics.filter((t) => !watch.topics.some((x) => x.field.toLowerCase() === t.field.toLowerCase()));
  writeJsonAtomic(file, { topics: [...watch.topics, ...current] });
  let digest = null;
  if (dirs) {
    fs.mkdirSync(dirs.watch, { recursive: true });
    digest = path.join(dirs.watch, `${today(now)}.md`);
    const news = sections.some((s) => s.papers.length || s.stories.length || s.error);
    if (!fs.existsSync(digest)) {
      fs.writeFileSync(digest, digestNote(today(now), sections));
    } else if (news) {
      // A second check the same day adds an update below the morning's list instead of replacing it.
      const body = digestNote(today(now), sections).replace(/^---[\s\S]*?\n# Research watch [^\n]*\n/, '');
      fs.appendFileSync(digest, `\n---\n\n# Update ${pad2(now.getHours())}:${pad2(now.getMinutes())}\n${body}`);
    }
    writeWatchIndex(dirs);
  }
  return {
    fields: sections.length,
    papers: sections.reduce((n, s) => n + s.papers.length, 0),
    flagged: sections.reduce((n, s) => n + s.papers.filter((p) => p.touches.length).length, 0),
    errors: sections.filter((s) => s.error).map((s) => `${s.field}: ${s.error}`),
    digest,
  };
}

// ---------- running it every day ----------

const TASK_NAME = 'Claude HQ research watch';

/**
 * The command that runs the watch: `node <engine>/bin/hq.js watch`, wrapped in config.watch.launcher
 * when set (on Windows, a launcher such as pythonw with a hide-window script keeps a console from flashing).
 */
export function watchCommand(config = loadConfig()) {
  const launcher = Array.isArray(config.watch?.launcher) ? config.watch.launcher.map(String) : [];
  return [...launcher, process.execPath, path.join(ENGINE_DIR, 'bin', 'hq.js'), 'watch'];
}

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * Registers the daily run. Windows: a Task Scheduler task at `time` (HH:MM). Elsewhere: returns the
 * crontab line for the owner to add, since editing a crontab silently is not ours to do.
 */
export function scheduleWatch({ time = '08:00', config = loadConfig() } = {}) {
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`--time must be HH:MM, got "${time}"`);
  const argv = watchCommand(config);
  if (process.platform !== 'win32') {
    const [hh, mm] = time.split(':');
    return { scheduled: false, instructions: `Add this line with \`crontab -e\`:\n${Number(mm)} ${Number(hh)} * * * ${argv.map(quote).join(' ')}` };
  }
  const tr = argv.map(quote).join(' ');
  const res = spawnSync('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/ST', time, '/TN', TASK_NAME, '/TR', tr], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`Task Scheduler refused: ${(res.stderr || res.stdout || '').trim()}`);
  return { scheduled: true, instructions: `Scheduled "${TASK_NAME}" daily at ${time}: ${tr}` };
}
