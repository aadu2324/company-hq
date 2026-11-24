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
  models: { ceo: 'opus', board: 'opus', orgDesigner: 'opus', manager: 'sonnet', reviewer: 'sonnet' },
  permissionMode: 'acceptEdits',
  claudePath: null,
  /** GPU memory in GB, if any; the engine cannot detect it. Used in the workers' brief. */
  vramGB: null,
});

export function loadConfig() {
  const file = readJson(path.join(COMPANY_DIR, 'config.json'), {}) || {};
  // HQ_CONFIG_JSON lets tests (and one-off runs) override settings without touching config.json.
  let env = {};
  try { env = JSON.parse(process.env.HQ_CONFIG_JSON || '{}'); } catch { env = {}; }
  const user = { ...file, ...env };
  return { ...DEFAULTS, ...user, models: { ...DEFAULTS.models, ...(file.models || {}), ...(env.models || {}) } };
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
