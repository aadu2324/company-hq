import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentNamesIn, availableAgents, pickAgent, resolveRoleAgent, FALLBACK_AGENT } from '../src/agents.js';

/** A fake ~/.claude plus a fake plugin folder, built from objects so nothing is hand-escaped. */
function fixture({ userAgents = [], plugins = {}, disabled = [], self = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqagents-'));
  const claudeDir = path.join(root, '.claude');
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  for (const a of userAgents) write(path.join(claudeDir, 'agents', `${a}.md`), `---\nname: ${a}\n---\nbody\n`);
  const installed = {};
  for (const [name, agents] of Object.entries(plugins)) {
    const installPath = path.join(root, 'cache', name);
    for (const a of agents) write(path.join(installPath, 'agents', `${a}.md`), `---\nname: ${a}\n---\n`);
    installed[`${name}@market`] = [{ scope: 'user', installPath }];
  }
  write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }));
  write(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: Object.fromEntries(disabled.map((d) => [`${d}@market`, false])) }));
  let pluginDir = null;
  if (self) {
    pluginDir = path.join(root, 'self');
    write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: self.name }));
    for (const a of self.agents) write(path.join(pluginDir, 'agents', `${a}.md`), `---\nname: ${a}\n---\n`);
  }
  return { claudeDir, pluginDir };
}

test('agentNamesIn prefers the frontmatter name over the file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqnames-'));
  fs.writeFileSync(path.join(dir, 'file-name.md'), '---\nname: real-name\ndescription: x\n---\n');
  fs.writeFileSync(path.join(dir, 'no-front.md'), 'just text\n');
  assert.deepEqual(agentNamesIn(dir).sort(), ['no-front', 'real-name']);
  assert.deepEqual(agentNamesIn(path.join(dir, 'missing')), []);
});

test('plugin agents are namespaced by plugin, and a disabled plugin contributes none', () => {
  const f = fixture({ plugins: { ecc: ['code-reviewer'], off: ['ghost'] }, disabled: ['off'] });
  const { names } = availableAgents({ claudeDir: f.claudeDir });
  assert.ok(names.has('ecc:code-reviewer'));
  assert.ok(!names.has('code-reviewer'));
  assert.ok(!names.has('off:ghost'));
  assert.ok(names.has('general-purpose'));
});

test("this plugin's own agents count only once the plugin is installed", () => {
  const installed = fixture({ plugins: { 'company-hq': [] }, self: { name: 'company-hq', agents: ['co-ceo'] } });
  assert.ok(availableAgents(installed).names.has('company-hq:co-ceo'));
  const cloneOnly = fixture({ self: { name: 'company-hq', agents: ['co-ceo'] } });
  assert.ok(!availableAgents(cloneOnly).names.has('company-hq:co-ceo'));
});

test('a bare name matches a loose user agent first, then this plugin\'s namespaced copy', () => {
  const both = { names: new Set(['co-ceo', 'company-hq:co-ceo']), self: 'company-hq' };
  assert.equal(pickAgent(['co-ceo'], both), 'co-ceo');
  const pluginOnly = { names: new Set(['company-hq:co-ceo']), self: 'company-hq' };
  assert.equal(pickAgent(['co-ceo'], pluginOnly), 'company-hq:co-ceo');
  const otherPlugin = { names: new Set(['other:co-ceo']), self: 'company-hq' };
  assert.equal(pickAgent(['co-ceo'], otherPlugin), null);
});

test('preferences are tried in order: ECC when installed, the bundled reviewer when not', () => {
  const role = { title: 'Code Reviewer', agent: ['ecc:code-reviewer', 'co-qa-reviewer'], charter: 'Review it.' };
  const withEcc = { names: new Set(['ecc:code-reviewer', 'company-hq:co-qa-reviewer']), self: 'company-hq' };
  assert.equal(resolveRoleAgent(role, withEcc).agent, 'ecc:code-reviewer');
  const withoutEcc = { names: new Set(['company-hq:co-qa-reviewer']), self: 'company-hq' };
  assert.equal(resolveRoleAgent(role, withoutEcc).agent, 'company-hq:co-qa-reviewer');
});

test('a role with no available agent falls back to general-purpose and keeps a charter', () => {
  const none = { names: new Set(['general-purpose']), self: 'company-hq' };
  const withCharter = resolveRoleAgent({ title: 'SEO Specialist', agent: ['ecc:seo-specialist'], charter: 'Fix SEO.' }, none);
  assert.equal(withCharter.agent, FALLBACK_AGENT);
  assert.equal(withCharter.isFallback, true);
  assert.equal(withCharter.charter, 'Fix SEO.');
  const noCharter = resolveRoleAgent({ title: 'Archivist', agent: 'ecc:archivist' }, none);
  assert.match(noCharter.charter, /Archivist/);
  const found = resolveRoleAgent({ title: 'Planner', agent: ['ecc:planner', 'Plan'] }, { names: new Set(['Plan']), self: null });
  assert.equal(found.agent, 'Plan');
  assert.equal(found.isFallback, undefined);
});
