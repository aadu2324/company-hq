/**
 * The owner's second brain: what runs and the watcher learn is filed into the Obsidian vault as
 * linked notes, so one place holds the literature, the open gaps and the fields they belong to.
 *
 *   <knowledge>/Literature/<Field>/<year> <title>.md   one note per paper (from BibTeX or the watcher)
 *   <knowledge>/Gaps/<Field>/<gap title>.md           research gaps and market opportunities
 *   <knowledge>/Fields/<Field>.md                     a hub per field linking its papers, gaps and projects
 *
 * <knowledge> is config.obsidian.knowledgeFolder inside the vault (default: the vault root). Notes that
 * already exist are left alone, so the owner's own annotations survive; hubs are regenerated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { safeName } from './obsidian.js';

const MAX_TITLE = 90;
const GENERATED = '<!-- written by company-hq; notes are created once and then left to you -->';

/** The knowledge folders inside the vault, or null when Obsidian is not set up. Never outside the vault. */
export function knowledgeDirs(config = loadConfig()) {
  const vault = config.obsidian?.vault;
  if (!vault || !fs.existsSync(vault)) return null;
  const root = path.resolve(vault, String(config.obsidian.knowledgeFolder || '').replace(/^[\\/]+|[\\/]+$/g, ''));
  const inside = path.relative(path.resolve(vault), root);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return {
    literature: path.join(root, 'Literature'),
    gaps: path.join(root, 'Gaps'),
    fields: path.join(root, 'Fields'),
    watch: path.join(root, 'Research Watch'),
  };
}

// ---------- reading what workers wrote ----------

/** The bodies of fenced code blocks tagged `tag` (```tag … ```). */
export function fencedBlocks(markdown, tag) {
  const re = new RegExp('```' + tag + '[^\\n]*\\n([\\s\\S]*?)```', 'g');
  return [...String(markdown || '').matchAll(re)].map((m) => m[1]);
}

/** JSON arrays (or single objects) from tagged blocks; invalid blocks are skipped. */
export function jsonBlocks(markdown, tag) {
  return fencedBlocks(markdown, tag).flatMap((body) => {
    try {
      const v = JSON.parse(body);
      return Array.isArray(v) ? v : [v];
    } catch {
      return [];
    }
  }).filter((v) => v && typeof v === 'object');
}

/** A forgiving BibTeX reader: entries with their fields, braces and quotes stripped. */
export function parseBibtex(text) {
  const entries = [];
  const src = String(text || '');
  const start = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m;
  while ((m = start.exec(src))) {
    let depth = 1;
    let i = start.lastIndex;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
    }
    const body = src.slice(start.lastIndex, i - 1);
    const fields = {};
    const field = /(\w+)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g;
    let f;
    while ((f = field.exec(body))) fields[f[1].toLowerCase()] = (f[3] ?? f[4] ?? f[5] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    if (fields.title) entries.push({ type: m[1].toLowerCase(), key: m[2], ...fields });
    start.lastIndex = i;
  }
  return entries;
}

// ---------- notes ----------

const yaml = (s) => JSON.stringify(String(s ?? ''));
const pad2 = (n) => String(n).padStart(2, '0');
/** Today in the owner's local time. */
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
// Tags go unquoted into YAML flow lists, so they are kept to letters, digits and dashes.
const tagOf = (s) => safeName(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'field';

/** The best link for a paper: its URL, its DOI, or its arXiv id. */
export function paperLink(p) {
  if (p.url) return p.url;
  if (p.doi) return `https://doi.org/${p.doi}`;
  if (p.eprint) return `https://arxiv.org/abs/${p.eprint}`;
  return '';
}

export const paperNoteName = (p) => safeName(`${p.year || 'n.d.'} ${p.title}`, MAX_TITLE);

function literatureNote(p, { field, project, run, source }) {
  const link = paperLink(p);
  return `---
type: literature
title: ${yaml(p.title)}
authors: ${yaml(p.author || p.authors || '')}
year: ${yaml(p.year || '')}
venue: ${yaml(p.journal || p.booktitle || p.venue || '')}
link: ${yaml(link)}
field: ${yaml(field)}
source: ${yaml(source)}
added: ${yaml(localToday())}
tags: [literature, ${tagOf(field)}]
---
${GENERATED}

# ${safeName(p.title, 200)}

${p.author || p.authors ? `**Authors:** ${p.author || p.authors}  \n` : ''}${p.year ? `**Year:** ${p.year}  \n` : ''}${link ? `**Link:** ${link}\n` : ''}
Field: [[${safeName(field)}]]${project ? ` · Found for: [[${project}]]` : ''}${run ? ` · Run: [[${run}]]` : ''}

${p.abstract ? `## Abstract\n${String(p.abstract).trim()}\n` : ''}
## Notes
`;
}

function gapNote(g, { project, run }) {
  const evidence = (Array.isArray(g.evidence) ? g.evidence : []).map((e) => `- ${e}`).join('\n');
  const field = safeName(g.field || 'General');
  return `---
type: gap
kind: ${yaml(g.kind === 'market' ? 'market' : 'research')}
title: ${yaml(g.title)}
field: ${yaml(field)}
status: ${yaml(g.status || 'open')}
impact: ${Number(g.impact) || 0}
tractability: ${Number(g.tractability) || 0}
verifiability: ${Number(g.verifiability) || 0}
found: ${yaml(localToday())}
tags: [gap, ${g.kind === 'market' ? 'opportunity' : 'research-gap'}, ${tagOf(field)}]
---
${GENERATED}

# ${safeName(g.title, 200)}

Field: [[${field}]]${project ? ` · Found for: [[${project}]]` : ''}${run ? ` · Run: [[${run}]]` : ''}

${String(g.summary || '').trim()}

**Impact** ${Number(g.impact) || '–'}/5 · **Tractability** ${Number(g.tractability) || '–'}/5 · **Verifiability** ${Number(g.verifiability) || '–'}/5

## Evidence
${evidence || '- (none recorded)'}

## Watch
The daily watcher lists new papers that may close this gap in [[Research Watch]] digests.
`;
}

/** Writes a note only if it does not exist yet. Returns true when written. */
function writeOnce(file, text) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

/** Writes one paper as a Literature note. Returns its note name. */
export function filePaper(dirs, paper, context) {
  const field = safeName(context.field) || 'General';
  const name = paperNoteName(paper);
  writeOnce(path.join(dirs.literature, field, `${name}.md`), literatureNote(paper, { ...context, field }));
  return name;
}

/** Writes one gap or opportunity. Returns its note name. */
export function fileGap(dirs, gap, context) {
  const field = safeName(gap.field) || 'General';
  const name = safeName(gap.title, MAX_TITLE);
  if (!name) return '';
  writeOnce(path.join(dirs.gaps, field, `${name}.md`), gapNote({ ...gap, field }, context));
  return name;
}

const notesIn = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort().reverse();
  } catch {
    return [];
  }
};

/** Regenerates a field's hub: every paper and gap filed under it. */
export function writeFieldHub(dirs, field) {
  const name = safeName(field) || 'General';
  const papers = notesIn(path.join(dirs.literature, name));
  const gaps = notesIn(path.join(dirs.gaps, name));
  fs.mkdirSync(dirs.fields, { recursive: true });
  fs.writeFileSync(path.join(dirs.fields, `${name}.md`), `---
type: field
field: ${yaml(name)}
papers: ${papers.length}
gaps: ${gaps.length}
tags: [field, ${tagOf(name)}]
---
<!-- written by company-hq: this hub is regenerated; put your own notes in a separate note that links here -->

# ${name}

Everything HQ has filed for this field. New papers arrive daily through the [[Research Watch]].

## Open gaps and opportunities (${gaps.length})
${gaps.map((g) => `- [[${g}]]`).join('\n') || '- none yet'}

## Literature (${papers.length})
${papers.map((p) => `- [[${p}]]`).join('\n') || '- none yet'}
`);
}

/**
 * Files what one approved deliverable found: papers from its BibTeX blocks, gaps from hq-gaps, and the
 * fields to watch from hq-watch. Returns { papers, gaps, topics } (topics for the watcher to register).
 */
export function fileDeliverable(markdown, { project = '', run = '', config = loadConfig() } = {}) {
  const dirs = knowledgeDirs(config);
  const gaps = jsonBlocks(markdown, 'hq-gaps').filter((g) => g.title);
  const topics = jsonBlocks(markdown, 'hq-watch').filter((t) => t.field && (t.arxiv || t.hn));
  const papers = fencedBlocks(markdown, 'bibtex').flatMap(parseBibtex);
  if (!dirs) return { papers: 0, gaps: 0, topics };
  const field = gaps[0]?.field || topics[0]?.field || 'General';
  for (const p of papers) filePaper(dirs, p, { field, project, run, source: `HQ run ${run}` });
  for (const g of gaps) fileGap(dirs, g, { project, run });
  for (const f of new Set([field, ...gaps.map((g) => g.field || 'General')])) writeFieldHub(dirs, f);
  return { papers: papers.length, gaps: gaps.length, topics };
}
