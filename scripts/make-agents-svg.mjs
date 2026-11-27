#!/usr/bin/env node
/**
 * Writes assets/hq-plan-agents.svg: the Plan and Agents tabs side by side during one run, animated with
 * CSS keyframes only (GitHub strips scripts from SVG). Run: node scripts/make-agents-svg.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'hq-plan-agents.svg');
const LOOP_S = 12;
const W = 880;
const H = 430;
const C = {
  bg: '#1c1917', panel: '#24201e', line: '#3a3532', text: '#f5eee6', dim: '#a8a29e', grey: '#8a827c',
  claude: '#d97757', green: '#78c88c', blue: '#6ea8fe', purple: '#b392f0', teal: '#4fc1c9', amber: '#e5b45a',
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const css = [];
const seen = new Set();

/** Visible only between start% and end% of the loop. */
function during(start, end) {
  const name = `d${start}_${end}`;
  if (!seen.has(name)) {
    seen.add(name);
    const a = start === 0 ? `0%,${end - 0.6}%{opacity:1}${end}%,100%{opacity:0}`
      : end === 100 ? `0%,${start - 0.6}%{opacity:0}${start}%,98.8%{opacity:1}100%{opacity:0}`
        : `0%,${start - 0.6}%{opacity:0}${start}%,${end - 0.6}%{opacity:1}${end}%,100%{opacity:0}`;
    css.push(`@keyframes ${name}{${a}}.${name}{animation:${name} ${LOOP_S}s linear infinite}`);
  }
  return name;
}

const text = (x, y, s, { fill = C.text, size = 13, weight = 400, cls = '', anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ''}>${esc(s)}</text>`;

/** A task card whose border and icon change colour as its status changes over the loop. */
function card(x, y, w, title, dept, states) {
  const out = [];
  for (const [label, col, icon, s, e] of states) {
    out.push(`<g class="${during(s, e)}"><rect x="${x}" y="${y}" width="${w}" height="44" rx="8" fill="${C.panel}" stroke="${col}" stroke-width="1.5"/>`
      + `${text(x + 12, y + 19, icon, { fill: col, size: 13, weight: 700 })}`
      + `<rect x="${x + w - 92}" y="${y + 8}" width="82" height="17" rx="8.5" fill="${col}"/>${text(x + w - 51, y + 20.5, label, { fill: C.bg, size: 10, weight: 700, anchor: 'middle' })}</g>`);
  }
  out.push(text(x + 30, y + 19, title, { weight: 700, size: 13 }));
  out.push(text(x + 12, y + 36, dept, { fill: C.dim, size: 11.5 }));
  return out.join('');
}

const p = [];
p.push(`<rect width="${W}" height="${H}" rx="14" fill="${C.bg}"/><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${C.line}"/>`);
for (const [i, col] of ['#ef6b6b', C.amber, C.green].entries()) p.push(`<circle cx="${22 + i * 20}" cy="20" r="6" fill="${col}"/>`);
p.push(text(W / 2, 25, 'Claude HQ  ·  Plan and Agents', { fill: C.dim, size: 12.5, anchor: 'middle' }));

// Left: the plan.
const LX = 20;
const LW = 410;
p.push(`<rect x="${LX}" y="44" width="${LW}" height="56" rx="10" fill="${C.panel}" stroke="${C.teal}"/>`);
p.push(text(LX + 14, 66, '◆ Goal', { fill: C.teal, weight: 700 }));
p.push(text(LX + 14, 88, 'Find an open gap in sparse attention and test it', { size: 12.5 }));
p.push(text(LX, 126, 'Step 1', { weight: 700 }));
p.push(text(LX + 64, 126, 'starts right away', { fill: C.dim, size: 11.5 }));
p.push(card(LX + 16, 136, LW - 16, 'Map the frontier', 'Frontier & Gap Discovery', [
  ['WORKING', C.blue, '●', 0, 30], ['APPROVED', C.green, '✓', 30, 100]]));
p.push(text(LX, 206, 'Step 2', { weight: 700 }));
p.push(text(LX + 64, 206, 'starts after T1 · your decision: gap 2', { fill: C.dim, size: 11.5 }));
p.push(card(LX + 16, 216, LW - 16, 'Prove the bound', 'Theory & Proofs', [
  ['WAITING', C.grey, '○', 0, 40], ['WORKING', C.blue, '●', 40, 72], ['IN REVIEW', C.purple, '⚖', 72, 88], ['APPROVED', C.green, '✓', 88, 100]]));
p.push(card(LX + 16, 268, LW - 16, 'Run the experiment', 'Experiments', [
  ['WAITING', C.grey, '○', 0, 40], ['WORKING', C.blue, '●', 40, 80], ['APPROVED', C.green, '✓', 80, 100]]));
p.push(text(LX, 344, 'Step 3', { weight: 700 }));
p.push(text(LX + 64, 344, 'starts after T2, T3', { fill: C.dim, size: 11.5 }));
p.push(card(LX + 16, 354, LW - 16, 'Write the paper', 'Writing & Submission', [
  ['WAITING', C.grey, '○', 0, 90], ['WORKING', C.blue, '●', 90, 100]]));

// Right: the agents.
const RX = 450;
const RW = 410;
p.push(`<rect x="${RX}" y="44" width="${RW}" height="232" rx="10" fill="${C.panel}" stroke="${C.green}"/>`);
p.push(text(RX + 14, 66, '● Working now', { fill: C.green, weight: 700 }));
const agents = [
  // [icon, colour, who, doing, start%, end%]
  ['■', C.blue, 'Discovery · T1', 'running the task', 0, 30],
  ['●', C.green, 'gap-analyst', 'map sparse attention', 0, 28],
  ['●', C.green, 'literature-scout', 'verify citations', 4, 26],
  ['■', C.blue, 'Theory · T2', 'running the task', 40, 72],
  ['●', C.green, 'theorist', 'attempt the bound in Lean', 42, 70],
  ['■', C.blue, 'Experiments · T3', 'running the task', 40, 80],
  ['●', C.green, 'experimentalist', 'reproduce the baseline', 44, 78],
  ['⚖', C.purple, 'Review · T2', 'proof verifier checking', 72, 88],
  ['■', C.blue, 'Writing · T4', 'running the task', 90, 100],
];
const slots = new Map();
for (const [icon, col, who, doing, s, e] of agents) {
  // Stack agents that overlap in time into rows, reusing a row once its agent has finished.
  let row = 0;
  while ((slots.get(row) ?? -1) > s) row += 1;
  slots.set(row, e);
  const y = 92 + row * 26;
  p.push(`<g class="${during(s, e)}">${text(RX + 14, y, '⠿', { fill: col, size: 13 })}${text(RX + 32, y, icon, { fill: col, size: 13 })}`
    + `${text(RX + 50, y, who, { weight: 700, size: 12.5 })}${text(RX + 50 + who.length * 7.6 + 8, y, `· ${doing}`, { fill: C.dim, size: 12 })}</g>`);
}
p.push(`<rect x="${RX}" y="288" width="${RW}" height="118" rx="10" fill="none" stroke="${C.line}"/>`);
p.push(text(RX + 14, 310, 'Recently finished', { weight: 700 }));
const finished = [
  ['✓', C.green, 'gap-analyst', '4m 12s', 28],
  ['✓', C.green, 'Discovery · T1', '6m 40s', 30],
  ['✓', C.green, 'experimentalist', '9m 05s', 78],
  ['✓', C.green, 'Review · T2', '2m 31s', 88],
];
finished.forEach(([mark, col, who, took, at], i) => {
  const y = 334 + i * 20;
  p.push(`<g class="${during(at, 100)}">${text(RX + 14, y, mark, { fill: col, size: 13, weight: 700 })}${text(RX + 34, y, who, { size: 12.5 })}${text(RX + RW - 16, y, took, { fill: C.dim, size: 12, anchor: 'end' })}</g>`);
});

css.push(`@keyframes spin{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}text{font-family:${MONO}}`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Animated preview of the HQ Plan and Agents tabs during a research run">
<style>${css.join('')}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>
${p.join('\n')}
</svg>
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${svg.length} bytes)`);
