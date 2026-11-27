import fs from 'node:fs';
import path from 'node:path';
import { templatePath, companyDir } from './config.js';
import { readJson, writeJsonAtomic } from './fsutil.js';

export const PROJECT_TYPES = ['startup', 'research', 'software', 'frontier'];

export function loadTemplate(type) {
  const t = PROJECT_TYPES.includes(type) ? type : 'software';
  const tpl = readJson(templatePath(t));
  if (!tpl) throw new Error(`Template not found: ${t}`);
  return tpl;
}

export function loadOrg(projectPath) {
  return readJson(path.join(companyDir(projectPath), 'org.json'));
}

export function saveOrg(projectPath, org) {
  const dir = companyDir(projectPath);
  writeJsonAtomic(path.join(dir, 'org.json'), org);
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'runs/\nevents.jsonl\n');
}

const MAX_TITLE = 80;
const MAX_CHARTER = 600;

/**
 * Resolve a worker/reviewer reference (catalog id or inline object) to a full role.
 * org.json can arrive with a cloned repo, so an inline role is treated as untrusted: it always runs
 * as general-purpose (its own `agent` is ignored) and its title and charter are clipped.
 */
export function resolveRole(ref, catalog) {
  if (ref && typeof ref === 'object') {
    if (!ref.id || !ref.title) return null;
    return {
      id: String(ref.id).slice(0, MAX_TITLE),
      title: String(ref.title).slice(0, MAX_TITLE),
      charter: ref.charter ? String(ref.charter).slice(0, MAX_CHARTER) : undefined,
      agent: 'general-purpose',
      kind: ref.kind === 'reviewer' ? 'reviewer' : 'worker',
    };
  }
  const role = catalog.roles[ref];
  return role ? { id: ref, ...role } : null;
}

/** Validate an org chart against the catalog. Returns { ok, errors }. */
export function validateOrg(org, catalog) {
  const errors = [];
  if (!org || typeof org !== 'object') return { ok: false, errors: ['org is not an object'] };
  const execIds = new Set((org.executives || []).map((e) => e.id));
  if (!execIds.has('ceo')) errors.push('executives must include id "ceo"');
  const depts = org.departments || [];
  if (depts.length === 0) errors.push('at least one department is required');
  const deptIds = new Set();
  for (const d of depts) {
    if (!d.id || !d.name) { errors.push('department missing id or name'); continue; }
    if (deptIds.has(d.id)) errors.push(`duplicate department id "${d.id}"`);
    deptIds.add(d.id);
    if (d.reportsTo && !execIds.has(d.reportsTo)) errors.push(`${d.id}: reportsTo "${d.reportsTo}" is not an executive`);
    for (const w of d.workers || []) {
      if (!resolveRole(w, catalog)) errors.push(`${d.id}: unknown worker role ${JSON.stringify(w)}`);
    }
    for (const r of d.reviewers || []) {
      if (!resolveRole(r, catalog)) errors.push(`${d.id}: unknown reviewer role ${JSON.stringify(r)}`);
    }
    if (!(d.workers || []).length) errors.push(`${d.id}: needs at least one worker`);
    if (!(d.reviewers || []).length) errors.push(`${d.id}: needs at least one reviewer`);
  }
  return { ok: errors.length === 0, errors };
}

/** Flatten the org into indented rows for display: [{ depth, label, kind, key }]. */
export function orgRows(org, catalog) {
  if (!org) return [];
  const rows = [{ depth: 0, label: 'Board of Directors', kind: 'board', key: 'board' }];
  const execs = org.executives || [];
  const children = (parentId) => execs.filter((e) => (e.reportsTo || null) === parentId);
  const walk = (exec, depth) => {
    rows.push({ depth, label: exec.title, kind: 'exec', key: `exec:${exec.id}` });
    for (const d of (org.departments || []).filter((x) => (x.reportsTo || 'ceo') === exec.id)) {
      rows.push({ depth: depth + 1, label: `${d.name} — ${d.manager || 'Manager'}`, kind: 'dept', key: `dept:${d.id}` });
      for (const w of d.workers || []) {
        const role = resolveRole(w, catalog);
        if (role) rows.push({ depth: depth + 2, label: role.title, kind: 'worker', key: `agent:${role.agent}`, dept: d.id });
      }
      const reviewers = (d.reviewers || []).map((r) => resolveRole(r, catalog)?.title).filter(Boolean);
      if (reviewers.length) rows.push({ depth: depth + 2, label: `review: ${reviewers.join(', ')}`, kind: 'review', key: `review:${d.id}`, dept: d.id });
    }
    for (const c of children(exec.id)) walk(c, depth + 1);
  };
  for (const root of children(null)) walk(root, 1);
  return rows;
}
