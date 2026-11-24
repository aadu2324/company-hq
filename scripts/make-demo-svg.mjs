#!/usr/bin/env node
/**
 * Writes assets/hq-demo.svg: a looping, animated picture of one company run in the HQ pane,
 * for the README. CSS keyframes only (GitHub strips scripts from SVG). Run: node scripts/make-demo-svg.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'hq-demo.svg');
const LOOP_S = 14;
const W = 880;
const H = 590;
const C = {
  bg: '#1c1917', panel: '#24201e', line: '#3a3532', text: '#f5eee6', dim: '#a8a29e',
  claude: '#d97757', green: '#78c88c', blue: '#6ea8fe', purple: '#b392f0', teal: '#4fc1c9', amber: '#e5b45a',
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const keyframes = [];
const seen = new Set();

/** A class that shows its element only between start% and end% of the loop. */
function windowClass(start, end) {
  const name = `w${start}_${end}`.replace(/\./g, 'p');
  if (!seen.has(name)) {
    seen.add(name);
    const on = start === 0 ? '0%' : `${start - 0.6}%`;
    const steps = start === 0
      ? `0%,${end - 0.6}%{opacity:1}${end}%,100%{opacity:0}`
      : end === 100
        ? `0%,${on}{opacity:0}${start}%,98.8%{opacity:1}100%{opacity:0}`
        : `0%,${on}{opacity:0}${start}%,${end - 0.6}%{opacity:1}${end}%,100%{opacity:0}`;
    keyframes.push(`@keyframes ${name}{${steps}}.${name}{animation:${name} ${LOOP_S}s linear infinite}`);
  }
  return name;
}

/** A class that recolours a stage: grey, then active colour, then green, between the given %. */
function stageClass(i, activeAt, doneAt) {
  const name = `st${i}`;
  const grey = '#6b645f';
  const steps = activeAt === 0
    ? `0%,${doneAt - 0.6}%{fill:${C.claude}}${doneAt}%,98.8%{fill:${C.green}}100%{fill:${C.claude}}`
    : `0%,${activeAt - 0.6}%{fill:${grey}}${activeAt}%,${doneAt - 0.6}%{fill:${C.claude}}${doneAt}%,98.8%{fill:${C.green}}100%{fill:${grey}}`;
  keyframes.push(`@keyframes ${name}{${steps}}.${name}{animation:${name} ${LOOP_S}s linear infinite}`);
  return name;
}

const text = (x, y, s, { fill = C.text, size = 14, weight = 400, cls = '', anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ''}>${esc(s)}</text>`;

/** A status pill: coloured rounded rect with dark bold text, shown in its time window. */
function pill(x, y, label, fill, start, end, width = 110) {
  return `<g class="${windowClass(start, end)}"><rect x="${x}" y="${y - 15}" width="${width}" height="21" rx="10.5" fill="${fill}"/>`
    + `${text(x + width / 2, y, label, { fill: C.bg, size: 11.5, weight: 700, anchor: 'middle' })}</g>`;
}

const parts = [];

// Window and title bar.
parts.push(`<rect width="${W}" height="${H}" rx="14" fill="${C.bg}"/>`);
parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${C.line}"/>`);
for (const [i, col] of ['#ef6b6b', C.amber, C.green].entries()) parts.push(`<circle cx="${22 + i * 20}" cy="20" r="6" fill="${col}"/>`);
parts.push(text(W / 2, 25, 'Claude Code  ·  HQ pane', { fill: C.dim, size: 12.5, anchor: 'middle' }));

// Header card.
parts.push(`<rect x="20" y="44" width="${W - 40}" height="72" rx="10" fill="${C.panel}" stroke="${C.claude}"/>`);
parts.push(text(38, 74, '◆ Claude HQ', { fill: C.claude, size: 16, weight: 700 }));
parts.push(text(160, 74, 'Acme', { weight: 700, size: 16 }));
parts.push(text(212, 74, 'startup', { fill: C.dim, size: 13 }));
parts.push(`<g transform="translate(${W - 186} 68)"><circle r="7" fill="none" stroke="${C.line}" stroke-width="2.5"/>`
  + `<path d="M0 -7 A7 7 0 0 1 7 0" fill="none" stroke="${C.claude}" stroke-width="2.5" stroke-linecap="round" class="spin"/></g>`);
parts.push(pill(W - 166, 74, 'PLANNING', C.teal, 0, 20, 128));
parts.push(pill(W - 166, 74, 'WORKING', C.blue, 20, 60, 128));
parts.push(pill(W - 166, 74, 'BOARD REVIEW', C.purple, 60, 80, 128));
parts.push(pill(W - 166, 74, 'DONE', C.green, 80, 100, 128));
const stats = [
  [0, 20, '1 agent working  ·  0/3 tasks approved  ·  $0.04  ·  1m'],
  [20, 60, '4 agents working  ·  tasks moving  ·  $0.31  ·  6m'],
  [60, 80, '1 agent working  ·  3/3 tasks approved  ·  $0.52  ·  11m'],
  [80, 100, 'no agents working  ·  3/3 tasks approved  ·  $0.58  ·  12m'],
];
for (const [s, e, line] of stats) parts.push(text(38, 100, line, { fill: C.dim, size: 12.5, cls: windowClass(s, e) }));

// Tabs.
const tabs = [['Overview', true], ['Team 8', false], ['Tasks 3', false], ['Activity', false]];
let tx = 20;
for (const [label, isOn] of tabs) {
  const w = 18 + label.length * 8.4;
  parts.push(`<rect x="${tx}" y="128" width="${w}" height="26" rx="6" fill="${isOn ? C.claude : 'none'}" stroke="${isOn ? C.claude : C.line}"/>`);
  parts.push(text(tx + w / 2, 145.5, label, { fill: isOn ? C.bg : C.dim, size: 12.5, weight: isOn ? 700 : 400, anchor: 'middle' }));
  tx += w + 8;
}

// Stage pipeline.
const stages = [['Plan', 0, 20], ['Build', 20, 50], ['Review', 50, 60], ['Board', 60, 80], ['Report', 80, 80.5]];
stages.forEach(([label, a, d], i) => {
  const x = 30 + i * 172;
  const cls = stageClass(i, a, d);
  parts.push(`<circle cx="${x + 6}" cy="182" r="6" class="${cls}"/>`);
  parts.push(`<text x="${x + 20}" y="187" font-size="14" font-weight="700" class="${cls}">${label}</text>`);
  if (i < stages.length - 1) parts.push(`<rect x="${x + 92}" y="181" width="66" height="2" rx="1" class="${cls}"/>`);
});

// "Now" card.
parts.push(`<rect x="20" y="204" width="${W - 40}" height="64" rx="10" fill="${C.panel}" stroke="${C.blue}"/>`);
parts.push(text(38, 228, '⠿ Now', { fill: C.blue, size: 13.5, weight: 700 }));
const now = [
  [0, 20, 'The CEO is reading the project and splitting the request into 3 tasks.'],
  [20, 60, 'Engineering is building “Public API” with 2 agents; Marketing is drafting “Launch emails”.'],
  [60, 80, 'The Board is reviewing everything that was delivered.'],
  [80, 100, 'Finished. The Board approved: ship the API and send the drafts for your review.'],
];
for (const [s, e, line] of now) parts.push(text(38, 252, line, { size: 14, cls: windowClass(s, e) }));

// Progress.
parts.push(text(20, 294, 'Tasks approved', { fill: C.dim, size: 12.5 }));
for (const [s, e, n] of [[0, 35, 0], [35, 45, 1], [45, 55, 2], [55, 100, 3]]) {
  parts.push(text(W - 20, 294, `${n} of 3`, { fill: C.dim, size: 12.5, anchor: 'end', cls: windowClass(s, e) }));
}
parts.push(`<rect x="20" y="302" width="${W - 40}" height="10" rx="5" fill="${C.line}"/>`);
parts.push(`<rect x="20" y="302" width="${W - 40}" height="10" rx="5" fill="${C.green}" class="bar"/>`);
keyframes.push(`@keyframes bar{0%,34.4%{transform:scaleX(0.02)}35%,44.4%{transform:scaleX(0.333)}45%,54.4%{transform:scaleX(0.667)}55%,98.8%{transform:scaleX(1)}100%{transform:scaleX(0.02)}}`
  + `.bar{transform-box:fill-box;transform-origin:left center;animation:bar ${LOOP_S}s ease-in-out infinite}`);

// Tasks.
parts.push(text(20, 344, 'Tasks', { weight: 700, size: 14 }));
const tasks = [
  ['Build the public API', 'Engineering', [['WAITING', '#8a827c', 0, 20], ['WORKING', C.blue, 20, 35], ['APPROVED', C.green, 35, 100]]],
  ['Launch email sequence', 'Sales & Outreach', [['WAITING', '#8a827c', 0, 20], ['WORKING', C.blue, 20, 38], ['REVISING', C.amber, 38, 45], ['APPROVED', C.green, 45, 100]]],
  ['Landing page', 'Web & Landing Pages', [['WAITING', '#8a827c', 0, 28], ['WORKING', C.blue, 28, 48], ['IN REVIEW', C.purple, 48, 55], ['APPROVED', C.green, 55, 100]]],
];
tasks.forEach(([title, dept, states], i) => {
  const y = 372 + i * 28;
  for (const [label, col, s, e] of states) parts.push(pill(28, y, label, col, s, e, 96));
  parts.push(text(138, y, title, { weight: 700, size: 14 }));
  parts.push(text(138 + title.length * 8.6 + 12, y, `· ${dept}`, { fill: C.dim, size: 13 }));
});

// Activity.
parts.push(text(20, 476, 'Latest', { weight: 700, size: 14 }));
const feed = [
  [4, '10:16', '◆', C.teal, 'CEO planned 3 tasks: API, launch emails, landing page'],
  [36, '10:21', '✓', C.green, 'T1 approve 9/10: endpoints, tests and docs complete'],
  [40, '10:24', '⚖', C.amber, 'T2 revise 6/10: add the unsubscribe footer and sender address'],
  [62, '10:29', '⚖', C.purple, 'Board convened: chair, risk, quality'],
  [82, '10:31', '✓', C.green, 'Board: approve. Report written to .company/runs/…/report.md'],
];
feed.forEach(([at, time, icon, col, line], i) => {
  const y = 500 + i * 18;
  const cls = windowClass(at, 100);
  parts.push(`<g class="${cls}">${text(28, y, time, { fill: C.dim, size: 12.5 })}${text(76, y, icon, { fill: col, size: 13 })}${text(96, y, line, { size: 12.5 })}</g>`);
});

keyframes.push(`@keyframes spin{to{transform:rotate(360deg)}}.spin{transform-box:view-box;transform-origin:0 0;animation:spin 0.9s linear infinite}`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Animated preview of the Claude HQ pane during one company run">
<style>text{font-family:${MONO}}${keyframes.join('')}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>
${parts.join('\n')}
</svg>
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${svg.length} bytes, ${seen.size} timed layers)`);
