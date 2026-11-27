#!/usr/bin/env node
import path from 'node:path';
import { runEngine } from '../src/engine.js';
import { initTeam } from '../src/init.js';
import { startRun, stopRun, startInit, resumeRun, answerRun } from '../src/launcher.js';
import { obsidianDir, backfillObsidian } from '../src/obsidian.js';
import { loadWatch, addTopics, runWatch, scheduleWatch } from '../src/watch.js';
import { discoverProjects, normalizePath } from '../src/projects.js';
import { listRuns } from '../src/runstore.js';
import { liveSlots, freeMemMB } from '../src/slots.js';
import { loadConfig, ENGINE_DIR } from '../src/config.js';

const HELP = `Claude HQ — run your Claude Code setup like a company.

  hq                         open the dashboard
  hq init <path> [--type startup|research|software] [--no-tailor]
                             hire a team for a project (.company/org.json)
  hq run <path> "<request>"  hand a request to the company (runs in background)
  hq status [path]           show recent runs
  hq stop <path> <runId>     stop a run and its Claude processes
  hq resume <path> [runId]   carry on a paused or unfinished run (keeps approved work)
  hq answer <path> "<text>"  answer the question a run is waiting on; the CEO plans the rest
  hq watch [--schedule]      check arXiv and Hacker News for what is new in your tracked fields
  hq obsidian [path]         write every run into the Obsidian vault set in config.json
  hq projects                list projects Claude Code knows about
`;

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'ui': {
      let tui;
      try {
        tui = await import('../src/tui/app.js');
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
        throw new Error(`the terminal dashboard needs its packages. Run: npm install --prefix "${ENGINE_DIR}"`);
      }
      return tui.startTui();
    }
    case 'init': {
      if (!rest[0]) throw new Error('usage: hq init <path>');
      if (rest.includes('--background')) {
        startInit(normalizePath(rest[0]), flag(rest, '--type'));
        console.log('Hiring a team in the background (about 1-2 min). It appears in the HQ pane when ready.');
        return undefined;
      }
      await initTeam(normalizePath(rest[0]), { type: flag(rest, '--type'), tailor: !rest.includes('--no-tailor') });
      return undefined;
    }
    case 'run': {
      const [p, ...words] = rest;
      if (!p || !words.length) throw new Error('usage: hq run <path> "<request>"');
      const id = startRun(normalizePath(p), words.join(' '));
      console.log(`Run ${id} started. Watch it with: hq`);
      return undefined;
    }
    case 'status': {
      const projects = rest[0] ? [{ path: normalizePath(rest[0]), name: path.basename(rest[0]) }] : discoverProjects().filter((x) => x.hasCompany);
      const { maxProcesses } = loadConfig();
      console.log(`Slots ${liveSlots().length}/${maxProcesses} · free RAM ${freeMemMB()} MB`);
      for (const pr of projects) {
        for (const r of listRuns(pr.path, 5)) {
          const done = (r.tasks || []).filter((t) => t.status === 'approved').length;
          console.log(`${pr.name.padEnd(24)} ${r.id}  ${String(r.status).padEnd(18)} ${done}/${(r.tasks || []).length} tasks  ${r.prompt.slice(0, 50)}`);
        }
      }
      return undefined;
    }
    case 'stop': {
      if (!rest[1]) throw new Error('usage: hq stop <path> <runId>');
      stopRun(normalizePath(rest[0]), rest[1]);
      console.log('Stopped.');
      return undefined;
    }
    case 'resume': {
      if (!rest[0]) throw new Error('usage: hq resume <path> [runId]');
      const id = resumeRun(normalizePath(rest[0]), rest[1]);
      console.log(`Resumed ${id}. Approved work is kept; the rest runs again.`);
      return undefined;
    }
    case 'watch': {
      const sub = rest[0];
      if (sub === 'list') {
        const { topics } = loadWatch();
        if (!topics.length) console.log('No fields tracked yet. Runs add them, or: hq watch add "<field>" --arxiv "<query>" [--hn "<query>"]');
        for (const t of topics) console.log(`${t.field.padEnd(32)} last checked ${t.lastChecked || 'never'}  arXiv: ${t.arxiv || '-'}  HN: ${t.hn || '-'}`);
        return undefined;
      }
      if (sub === 'add') {
        if (!rest[1]) throw new Error('usage: hq watch add "<field>" --arxiv "<query>" [--hn "<query>"]');
        const added = addTopics([{ field: rest[1], arxiv: flag(rest, '--arxiv') || '', hn: flag(rest, '--hn') || '' }]);
        console.log(added ? `Now watching ${rest[1]}.` : `Updated ${rest[1]}.`);
        return undefined;
      }
      if (rest.includes('--schedule')) {
        console.log(scheduleWatch({ time: flag(rest, '--time') || '08:00' }).instructions);
        return undefined;
      }
      const r = await runWatch();
      console.log(`Checked ${r.fields} field(s): ${r.papers} new paper(s), ${r.flagged} touching an open gap.${r.digest ? ` Digest: ${r.digest}` : ''}`);
      for (const e of r.errors || []) console.log(`  ${e}`);
      return undefined;
    }
    case 'answer': {
      const [p, ...words] = rest;
      if (!p || !words.length) throw new Error('usage: hq answer <path> "<your answer>"');
      const id = answerRun(normalizePath(p), words.join(' '));
      console.log(`Answer recorded on ${id}. The CEO is planning the rest.`);
      return undefined;
    }
    case 'obsidian': {
      const dir = obsidianDir();
      if (!dir) throw new Error('Obsidian is not set up. Add { "obsidian": { "vault": "<vault folder>" } } to ~/.claude/company/config.json');
      const projects = rest[0] ? [{ path: normalizePath(rest[0]) }] : discoverProjects().filter((x) => x.hasCompany);
      const written = projects.reduce((n, pr) => n + backfillObsidian(pr.path), 0);
      console.log(`Wrote ${written} run note(s) to ${dir}`);
      return undefined;
    }
    case 'projects':
      for (const p of discoverProjects()) console.log(`${p.hasCompany ? '●' : '○'} ${p.type.padEnd(9)} ${p.path}`);
      return undefined;
    case '_engine':
      return runEngine(rest[0], rest[1]);
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return undefined;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`hq: ${err.message}`);
  process.exitCode = 1;
});
