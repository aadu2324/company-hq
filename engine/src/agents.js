/**
 * Which subagent types exist on this machine, and which one each catalog role should use.
 *
 * Claude Code names agents three ways: built-in (`general-purpose`), loose files in
 * ~/.claude/agents or <project>/.claude/agents (`co-ceo`), and plugin agents, namespaced by
 * plugin (`ecc:code-reviewer`, `company-hq:co-ceo`). A role lists the agents it would like,
 * best first; it gets the first that exists, or general-purpose with the role's charter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './fsutil.js';

export const BUILT_IN_AGENTS = Object.freeze(['general-purpose', 'Explore', 'Plan']);
export const FALLBACK_AGENT = 'general-purpose';

const NAME_LINE = /^name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/m;

/** Agent names defined by the .md files in one folder (frontmatter `name:`, else the file name). */
export function agentNamesIn(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
  return files.map((f) => {
    try {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 2048);
      const front = head.startsWith('---') ? head.split(/\r?\n---/)[0] : '';
      return NAME_LINE.exec(front)?.[1] || f.slice(0, -3);
    } catch {
      return f.slice(0, -3);
    }
  });
}

function pluginName(pluginDir) {
  return readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), null)?.name || null;
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Installed, enabled plugins as [{ name, installPath }] from Claude Code's own records. A plugin
 * installed for one project (project or local scope) counts only in that project.
 */
export function installedPlugins(claudeDir, projectPath) {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'), null)?.plugins || {};
  const enabled = readJson(path.join(claudeDir, 'settings.json'), null)?.enabledPlugins || {};
  const inScope = (e) => !e.scope || e.scope === 'user'
    || (typeof e.projectPath === 'string' && Boolean(projectPath) && samePath(e.projectPath, projectPath));
  return Object.entries(installed)
    .filter(([key]) => enabled[key] !== false)
    .flatMap(([key, entries]) => (Array.isArray(entries) ? entries : [])
      .filter((e) => e && typeof e.installPath === 'string' && inScope(e))
      .map((e) => ({ key, name: key.split('@')[0], installPath: e.installPath })));
}

/**
 * Every agent name a Claude Code session on this machine can spawn.
 * pluginDir is this engine's own plugin: its agents count once the plugin is installed,
 * read from pluginDir itself (a plugin installed from a folder runs from that folder).
 */
export function availableAgents({ claudeDir, projectPath, pluginDir }) {
  const names = new Set(BUILT_IN_AGENTS);
  for (const n of agentNamesIn(path.join(claudeDir, 'agents'))) names.add(n);
  if (projectPath) for (const n of agentNamesIn(path.join(projectPath, '.claude', 'agents'))) names.add(n);
  const plugins = installedPlugins(claudeDir, projectPath);
  for (const p of plugins) {
    for (const n of agentNamesIn(path.join(p.installPath, 'agents'))) names.add(`${p.name}:${n}`);
  }
  const self = pluginDir ? pluginName(pluginDir) : null;
  if (self && plugins.some((p) => p.name === self)) {
    for (const n of agentNamesIn(path.join(pluginDir, 'agents'))) names.add(`${self}:${n}`);
  }
  return { names, self };
}

/** The candidates a role asks for, best first. */
export function roleCandidates(role) {
  return [role?.agent, role?.fallback].flat().filter((c) => typeof c === 'string' && c);
}

/** The first candidate that exists; a bare name also matches this plugin's namespaced copy. */
export function pickAgent(candidates, { names, self }) {
  for (const c of candidates) {
    if (names.has(c)) return c;
    if (!c.includes(':') && self && names.has(`${self}:${c}`)) return `${self}:${c}`;
  }
  return null;
}

/** Resolve one role. The result's `agent` is always a string a session can spawn. */
export function resolveRoleAgent(role, available) {
  const picked = pickAgent(roleCandidates(role), available);
  if (picked) return { ...role, agent: picked };
  const charter = role.charter || `Act as the ${role.title}${role.description ? `: ${role.description}` : '.'}`;
  return { ...role, agent: FALLBACK_AGENT, charter, isFallback: true };
}

export function resolveCatalog(catalog, available) {
  const roles = Object.fromEntries(Object.entries(catalog.roles || {}).map(([id, role]) => [id, resolveRoleAgent(role, available)]));
  return { ...catalog, roles };
}
