import fs from 'node:fs';
import path from 'node:path';
import { HOME, REGISTRY_FILE, companyDir } from './config.js';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Separators are matched as [\\/] so the same rules hold on Windows, macOS and Linux.
const EXCLUDE = [
  /scratch-workspaces/i,
  /[\\/]AppData[\\/]/i,
  /[\\/]\.claude([\\/]|$)/i,
  /[\\/]Library[\\/]Application Support[\\/]/i,
  /[\\/][^\\/]+ Projects$/i, // a folder that only holds projects ("Research Projects")
];

export function normalizePath(p) {
  const resolved = path.resolve(String(p).replace(/\//g, path.sep));
  return resolved.replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`).replace(/[\\/]+$/, '');
}

export function isCandidate(p) {
  const norm = normalizePath(p);
  if (norm.toLowerCase() === normalizePath(HOME).toLowerCase()) return false;
  if (/^[A-Z]:$/i.test(norm)) return false;
  return !EXCLUDE.some((re) => re.test(norm));
}

/** Guess the project type from its location and contents. */
export function detectType(projectPath) {
  // A parent folder named for the kind of work ("Startup Projects", "research") is a strong hint.
  const parents = normalizePath(projectPath).split(/[\\/]/).slice(0, -1).join('/').toLowerCase();
  if (/(^|\/)[^/]*startup[^/]*(\/|$)/.test(parents)) return 'startup';
  if (/(^|\/)[^/]*research[^/]*(\/|$)/.test(parents)) return 'research';
  try {
    const names = fs.readdirSync(projectPath).map((n) => n.toLowerCase());
    if (names.some((n) => n.endsWith('.tex') || n === 'paper' || n === 'experiments')) return 'research';
    if (names.some((n) => n === 'landing' || n === 'marketing')) return 'startup';
  } catch { /* unreadable: fall through */ }
  return 'software';
}

export function loadRegistry() {
  return readJson(REGISTRY_FILE, { projects: [] }) || { projects: [] };
}

export function registerProject(projectPath) {
  const reg = loadRegistry();
  const norm = normalizePath(projectPath);
  if (reg.projects.some((p) => p.toLowerCase() === norm.toLowerCase())) return;
  writeJsonAtomic(REGISTRY_FILE, { projects: [...reg.projects, norm] });
}

/** Projects Claude Code knows about (~/.claude.json) plus HQ's own registry, deduped. */
export function discoverProjects() {
  const claudeJson = readJson(path.join(HOME, '.claude.json'), {}) || {};
  const raw = [...Object.keys(claudeJson.projects || {}), ...loadRegistry().projects];
  const seen = new Map();
  for (const p of raw) {
    if (!isCandidate(p)) continue;
    const norm = normalizePath(p);
    const key = norm.toLowerCase();
    if (seen.has(key) || !fs.existsSync(norm)) continue;
    seen.set(key, norm);
  }
  return [...seen.values()]
    .map((p) => ({
      path: p,
      name: path.basename(p),
      hasCompany: fs.existsSync(path.join(companyDir(p), 'org.json')),
      type: detectType(p),
    }))
    .sort((a, b) => Number(b.hasCompany) - Number(a.hasCompany) || a.name.localeCompare(b.name));
}
