import path from 'node:path';
import { loadConfig, loadCatalog, resolveClaude, companyDir, processOptions } from './config.js';
import { loadTemplate, validateOrg, saveOrg, PROJECT_TYPES } from './org.js';
import { detectType, registerProject } from './projects.js';
import { acquireSlot, releaseSlot } from './slots.js';
import { runClaude } from './claude.js';
import { orgDesignerPrompt } from './prompts.js';
import { ensureDir } from './fsutil.js';

const ORG_SCHEMA = {
  type: 'object',
  required: ['executives', 'departments'],
  properties: { project: { type: 'object' }, executives: { type: 'array' }, departments: { type: 'array' }, policies: { type: 'object' } },
};

/**
 * Hire a team for a project: start from the type's template, let the org designer tailor it,
 * and fall back to the plain template if the tailored org does not validate.
 */
export async function initTeam(projectPath, { type, tailor = true, log = console.log } = {}) {
  const projectType = PROJECT_TYPES.includes(type) ? type : detectType(projectPath);
  const template = loadTemplate(projectType);
  const catalog = loadCatalog(projectPath);
  const base = { ...template, project: { name: path.basename(projectPath), type: projectType, summary: '' } };
  let org = base;
  let source = 'template';
  if (tailor) {
    const config = loadConfig();
    log(`Org designer is tailoring the ${projectType} template…`);
    const slot = await acquireSlot({ ...config, label: 'Org designer', meta: { project: path.basename(projectPath), runId: 'init' } });
    try {
      const res = await runClaude({
        bin: resolveClaude(config), cwd: projectPath, ...processOptions(config, 'orgDesigner'),
        prompt: orgDesignerPrompt({ projectPath, template, catalog, type: projectType }),
        schema: ORG_SCHEMA, disallowedTools: ['Edit', 'Write', 'NotebookEdit'], permissionMode: 'default',
        name: 'HQ · Org designer', env: { HQ_RUN_ID: 'init' },
        logFile: path.join(ensureDir(companyDir(projectPath)), 'init.jsonl'),
      });
      if (res.ok && res.structured) {
        const candidate = {
          ...res.structured,
          version: 1,
          project: { ...base.project, ...(res.structured.project || {}), type: projectType },
          policies: { ...template.policies, ...(res.structured.policies || {}) },
        };
        const { ok, errors } = validateOrg(candidate, catalog);
        if (ok) { org = candidate; source = 'tailored'; } else log(`Tailored org rejected (${errors.join('; ')}); using template.`);
      } else {
        log(`Org designer failed (${res.error}); using template.`);
      }
    } finally {
      releaseSlot(slot);
    }
  }
  const { ok, errors } = validateOrg(org, catalog);
  if (!ok) throw new Error(`Template ${projectType} is invalid: ${errors.join('; ')}`);
  saveOrg(projectPath, { ...org, createdAt: new Date().toISOString(), source });
  registerProject(projectPath);
  log(`Team ready (${source}): ${org.departments.map((d) => d.name).join(', ')}`);
  return org;
}
