#!/usr/bin/env node
/**
 * delegation-log — PreToolUse/PostToolUse hook (matcher "Agent|Task").
 * Appends each subagent spawn/finish from an interactive Claude Code session to
 * <project>/.company/events.jsonl so the HQ dashboard shows delegation live.
 *
 * Only acts inside projects that have a .company folder. Skips HQ-launched processes
 * (HQ_RUN_ID set) because the engine logs those itself. Never blocks; always exits 0.
 */
const fs = require('fs');
const path = require('path');

const MAX_DEPTH = 8;

function findCompanyDir(start) {
  let dir = start;
  for (let i = 0; i < MAX_DEPTH && dir; i += 1) {
    const candidate = path.join(dir, '.company');
    if (fs.existsSync(path.join(candidate, 'org.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function main() {
  if (process.env.HQ_RUN_ID) return;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  if (!['Agent', 'Task'].includes(input.tool_name)) return;
  const company = findCompanyDir(input.cwd || process.cwd());
  if (!company) return;
  const ti = input.tool_input || {};
  const isPost = input.hook_event_name === 'PostToolUse';
  const record = {
    ts: new Date().toISOString(),
    source: 'interactive',
    session: input.session_id,
    type: isPost ? 'worker.done' : 'worker.start',
    toolUseId: input.tool_use_id || `${input.session_id}:${ti.description || ''}`,
    agent: ti.subagent_type || 'general-purpose',
    description: String(ti.description || '').slice(0, 120),
  };
  if (isPost) record.status = input.tool_response && input.tool_response.is_error ? 'failed' : 'done';
  fs.appendFileSync(path.join(company, 'events.jsonl'), `${JSON.stringify(record)}\n`);
}

try { main(); } catch { /* never break the session */ }
process.exit(0);
