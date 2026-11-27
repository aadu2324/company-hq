import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJson } from './fsutil.js';
import { availableAgents, resolveCatalog } from './agents.js';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');

/** The engine's own folder: bundled catalog.json and templates/ live here. */
export const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The plugin folder that holds the engine (agents/ sits beside engine/). */
export const PLUGIN_DIR = path.resolve(ENGINE_DIR, '..');

/** Per-user data: config.json, state/, and optional catalog.json / templates/ overrides. */
export const COMPANY_DIR = process.env.HQ_HOME || path.join(CLAUDE_DIR, 'company');
export const STATE_DIR = path.join(COMPANY_DIR, 'state');
export const SLOTS_DIR = path.join(STATE_DIR, 'slots');
export const REGISTRY_FILE = path.join(STATE_DIR, 'registry.json');

const BUNDLED_CATALOG = path.join(ENGINE_DIR, 'catalog.json');
const USER_CATALOG = path.join(COMPANY_DIR, 'catalog.json');
const BUNDLED_TEMPLATES = path.join(ENGINE_DIR, 'templates');
const USER_TEMPLATES = path.join(COMPANY_DIR, 'templates');

const DEFAULTS = Object.freeze({
  maxProcesses: 2,
  minFreeMemMB: 700,
  starvationGraceSec: 30,
  pollMs: 2000,
  permissionMode: 'acceptEdits',
  claudePath: null,
  /** GPU memory in GB, if any; the engine cannot detect it. Used in the workers' brief. */
  vramGB: null,
  profile: 'lean',
});

/**
 * How much usage a run may spend. Measured on real runs: review panels of 4–5 subagents were ~64% of
 * the cost (each finished reviewer wakes the panel to re-read everything), and every background
 * process carried ~77k tokens of hooks, MCP servers and skills it never used.
 *
 * lean (default): one reviewer pass covering every perspective, at most 2 perspectives and 1 revision
 *   round per task, Sonnet everywhere at medium effort, and background processes without hooks,
 *   MCP servers or skills (agents and CLAUDE.md are kept).
 * thorough: the full panel of reviewer subagents, 2 revision rounds, Opus for the CEO and Board,
 *   and the owner's full Claude Code setup in every process.
 */
export const PROFILES = Object.freeze({
  lean: {
    models: { ceo: 'sonnet', board: 'sonnet', orgDesigner: 'sonnet', manager: 'sonnet', reviewer: 'sonnet' },
    effort: { ceo: 'medium', board: 'medium', orgDesigner: 'medium', manager: 'medium', reviewer: 'medium' },
    isolate: true,
    reviewMode: 'single',
    reviewRounds: 1,
    maxReviewers: 2,
    maxWorkers: 2,
    maxTasks: 4,
  },
  thorough: {
    models: { ceo: 'opus', board: 'opus', orgDesigner: 'opus', manager: 'sonnet', reviewer: 'sonnet' },
    effort: {},
    isolate: false,
    reviewMode: 'panel',
    reviewRounds: 2,
    maxReviewers: 5,
    maxWorkers: 4,
    maxTasks: 8,
  },
});

export function loadConfig() {
  const file = readJson(path.join(COMPANY_DIR, 'config.json'), {}) || {};
  // HQ_CONFIG_JSON lets tests (and one-off runs) override settings without touching config.json.
  let env = {};
  try { env = JSON.parse(process.env.HQ_CONFIG_JSON || '{}'); } catch { env = {}; }
  const user = { ...file, ...env };
  const profileName = PROFILES[user.profile] ? user.profile : DEFAULTS.profile;
  const profile = PROFILES[profileName];
  return {
    ...DEFAULTS,
    ...profile,
    ...user,
    profile: profileName,
    models: { ...profile.models, ...(file.models || {}), ...(env.models || {}) },
    effort: { ...profile.effort, ...(file.effort || {}), ...(env.effort || {}) },
  };
}

/** A settings file that turns off the owner's hooks in background processes (agents and plugins stay). */
export function isolateSettingsFile() {
  const file = path.join(STATE_DIR, 'isolate-settings.json');
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ disableAllHooks: true }));
    }
    return file;
  } catch {
    return null;
  }
}

/** The extra process options a role runs with under the active profile. */
export function processOptions(config, role) {
  const settingsFile = config.isolate ? isolateSettingsFile() : null;
  return {
    model: config.models?.[role],
    effort: config.effort?.[role] || undefined,
    isolate: Boolean(config.isolate),
    settingsFile: settingsFile || undefined,
  };
}

/** The machine the company runs on, in one line for prompts: detected RAM plus configured VRAM. */
export function machineLine(config = loadConfig()) {
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  const vram = Number(config.vramGB) > 0 ? `${config.vramGB} GB VRAM` : 'no GPU memory configured';
  return `${ramGB} GB RAM / ${vram}`;
}

/** Bundled role catalog, with roles from ~/.claude/company/catalog.json layered on top. */
export function loadRawCatalog() {
  const bundled = readJson(BUNDLED_CATALOG);
  if (!bundled?.roles) throw new Error(`Role catalog missing or invalid: ${BUNDLED_CATALOG}`);
  const user = readJson(USER_CATALOG, null);
  return { ...bundled, roles: { ...bundled.roles, ...(user?.roles || {}) } };
}

/**
 * The catalog with every role's `agent` resolved to an agent that exists on this machine
 * (user, project, plugin or built-in), falling back to general-purpose with the role's charter.
 */
export function loadCatalog(projectPath) {
  return resolveCatalog(loadRawCatalog(), availableAgents({ claudeDir: CLAUDE_DIR, projectPath, pluginDir: PLUGIN_DIR }));
}

/** A user template in ~/.claude/company/templates wins over the bundled one. */
export function templatePath(type) {
  const user = path.join(USER_TEMPLATES, `${type}.json`);
  return fs.existsSync(user) ? user : path.join(BUNDLED_TEMPLATES, `${type}.json`);
}

/** Prefer the native claude binary; the npm .cmd shim needs a shell and mangles arguments. */
export function resolveClaude(config) {
  if (process.env.HQ_CLAUDE_BIN) return process.env.HQ_CLAUDE_BIN;
  const candidates = [
    config.claudePath,
    path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  return found || 'claude';
}

export function companyDir(projectPath) {
  return path.join(projectPath, '.company');
}
