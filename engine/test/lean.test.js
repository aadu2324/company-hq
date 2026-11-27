import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, loadConfig, processOptions } from '../src/config.js';
import { buildArgs } from '../src/claude.js';
import { reviewSystem, managerSystem } from '../src/prompts.js';
import { isUsageLimit, limitResetText } from '../src/stream.js';
import { loadCatalog } from '../src/config.js';
import { loadTemplate } from '../src/org.js';

const withConfig = (json, fn) => {
  const before = process.env.HQ_CONFIG_JSON;
  process.env.HQ_CONFIG_JSON = JSON.stringify(json);
  try { return fn(); } finally { if (before === undefined) delete process.env.HQ_CONFIG_JSON; else process.env.HQ_CONFIG_JSON = before; }
};

test('lean is the default profile: Sonnet everywhere, one review round, isolated processes', () => {
  const c = withConfig({}, loadConfig);
  assert.equal(c.profile, 'lean');
  assert.equal(c.models.ceo, 'sonnet');
  assert.equal(c.models.board, 'sonnet');
  assert.equal(c.reviewMode, 'single');
  assert.equal(c.reviewRounds, 1);
  assert.equal(c.isolate, true);
});

test('thorough keeps Opus for the CEO and Board and the full review panel', () => {
  const c = withConfig({ profile: 'thorough' }, loadConfig);
  assert.equal(c.models.ceo, 'opus');
  assert.equal(c.reviewMode, 'panel');
  assert.equal(c.isolate, false);
  assert.equal(processOptions(c, 'manager').isolate, false);
});

test('an owner model choice still wins over the profile', () => {
  const c = withConfig({ models: { ceo: 'opus' } }, loadConfig);
  assert.equal(c.models.ceo, 'opus');
  assert.equal(c.models.board, PROFILES.lean.models.board);
});

test('an isolated process drops MCP servers, skills and hooks, and passes effort', () => {
  const args = buildArgs({ ...processOptions(withConfig({}, loadConfig), 'reviewer'), prompt: 'x' });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  assert.ok(args.includes('--settings'), 'hooks are turned off through a settings file');
  const plain = buildArgs({ ...processOptions(withConfig({ profile: 'thorough' }, loadConfig), 'reviewer'), prompt: 'x' });
  assert.ok(!plain.includes('--strict-mcp-config'));
  assert.ok(!plain.includes('--settings'));
});

test('the single-pass review asks for no subagents; the panel dispatches them', () => {
  const catalog = loadCatalog();
  const task = { reviewers: ['code-reviewer', 'legal'] };
  const single = reviewSystem({ catalog, task, mode: 'single' });
  assert.match(single, /no subagents/);
  assert.match(single, /Code Reviewer/);
  assert.doesNotMatch(single, /subagent_type/);
  assert.match(reviewSystem({ catalog, task, mode: 'panel' }), /subagent_type/);
});

test('managers are told how many workers they may run at once', () => {
  const org = loadTemplate('startup');
  const text = managerSystem({ org, catalog: loadCatalog(), dept: org.departments[0], maxWorkers: 2 });
  assert.match(text, /at most 2 worker\(s\) at once/);
});

test('the usage-limit message is recognised, with its reset time; ordinary work about rate limits is not', () => {
  const msg = "You've hit your 5-hour limit · resets 4:20pm (America/Chicago)";
  assert.equal(isUsageLimit(msg), true);
  assert.equal(limitResetText(msg), '4:20pm (America/Chicago)');
  assert.equal(limitResetText(msg.replace('·', 'Â·')), '4:20pm (America/Chicago)');
  assert.equal(isUsageLimit('Implemented rate limiting middleware with a 100 req/min limit'), false);
  assert.equal(isUsageLimit('The build failed: missing module'), false);
});
